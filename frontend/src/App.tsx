import { useState, useEffect, useRef, useMemo } from 'react';
import { 
  Activity, Cpu, Disc, Database, Cpu as Chip, 
  Settings, Play, Square, RefreshCw, BarChart2, ShieldAlert, 
  Binary, Sliders, FileText
} from 'lucide-react';
import DigitalTwin from './DigitalTwin';
import './App.css';

// Type definitions for Telemetry
interface TelemetryPoint {
  time: number;
  ref: number;
  output: number;
  input: number;
  error: number;
  current: number;
  temp: number;
  // Present only when streaming from the ESP32 (not the backend simulator)
  dist?: number;
  tsrc?: 'model' | 'sensor';   // temperature from the on-device thermal model or the DS18B20
  dsrc?: 'fixed' | 'sensor';   // distance fixed placeholder or the HC-SR04
  idK?: number;                // on-device online identification (RLS)
  idTau?: number;
  idN?: number;
  idOk?: boolean;
  aKp?: number;                // self-tuned gains derived on the ESP32 (lambda rule)
  aKi?: number;
  vib?: number;                // MPU6050 vibration, g RMS
  idD?: number;                // identified input delay, samples
  nKp?: number;                // neural-tuner gains computed on the ESP32
  nKi?: number;
  tun?: 'nn' | 'lambda';       // Adaptive AI gain source
  an?: number;                 // anomaly score 0..1
  acl?: string;                // anomaly class
  zs?: number; zi?: number; zv?: number;   // z-scores vs the healthy baseline
  kdr?: number;                // K drift vs baseline, %
  twin?: number;               // digital-twin speed, RPM
  abp?: number;                // baseline learning progress 0..1
  therm?: number;              // thermal margin used 0..1
  mode?: string;               // controller mode actually running on the ESP32
  gKp?: number; gKi?: number; gKd?: number; // gains actually applied
  fault?: string;
}

interface HardwareInfo {
  mode: 'hardware' | 'simulator';
  port?: string;
  baud?: number;
  connected?: boolean;
  info?: Record<string, any>;
  status_lines?: string[];
}

interface NnReport {
  trained_at: string;
  n_plants: number;
  n_train: number;
  n_val: number;
  architecture: string;
  inputs: string[];
  cost_ratio_vs_optimum: { nn_median: number; nn_p90: number; lambda_median: number; lambda_p90: number };
  nn_better_than_lambda_pct: number;
  feature_importance: Record<string, number>;
  val_mse_normalised: number;
}

interface IdResult {
  status: string;
  message?: string;
  samples?: number;
  first_order?: { delay: number; K: number; tau: number; offset: number; fit_pct: number; rmse: number };
  second_order?: { delay: number; K: number; zeta: number; wn: number; poles: number[][]; fit_pct: number; rmse: number };
}

interface SavedRun {
  id: number;
  created: string;
  operator: string;
  title: string;
  source: string;
  controller: string;
  kp: number; ki: number; kd: number;
  metrics: Record<string, number | string | null>;
  model: Record<string, number | string | null>;
  n_samples: number;
  samples?: number[][];
}

interface AlarmEvent { t: string; kind: string; detail: string }

const API = 'http://localhost:8088';
const RECORD_SECONDS = 60;          // rolling recording used for identification, export, saved runs
const K_AT_12V = 1.2;               // motor gain measured at 12 V (firmware README), for the supply estimate

// Step-response metrics from a recorded segment (last setpoint change in the record).
function stepMetrics(rec: TelemetryPoint[]) {
  if (rec.length < 20) return null;
  let i0 = -1;
  for (let i = rec.length - 1; i > 0; i--) {
    if (Math.abs(rec[i].ref - rec[i - 1].ref) > 5) { i0 = i; break; }
  }
  if (i0 < 0) return null;
  const seg = rec.slice(i0);
  const r = seg[0].ref, y0 = rec[i0 - 1].output, step = r - y0;
  if (Math.abs(step) < 5 || seg.length < 20) return null;
  const t0 = seg[0].time;
  const rise = seg.find(p => (p.output - y0) / step >= 0.9);
  const band = 0.02 * Math.abs(r);
  let settle: number | null = null;
  for (let i = 0; i < seg.length; i++) {
    if (seg.slice(i).every(p => Math.abs(p.output - r) <= band)) { settle = seg[i].time - t0; break; }
  }
  const peak = step > 0 ? Math.max(...seg.map(p => p.output)) : Math.min(...seg.map(p => p.output));
  const overshoot = Math.max(0, ((peak - r) / step) * 100);
  const iae = seg.reduce((a, p) => a + Math.abs(p.ref - p.output) * 0.01, 0);
  const tail = seg.slice(-50);
  const ss = tail.reduce((a, p) => a + p.output, 0) / tail.length;
  return {
    from_rpm: +y0.toFixed(1), to_rpm: r,
    rise_time_s: rise ? +(rise.time - t0).toFixed(3) : null,
    settling_time_s: settle !== null ? +settle.toFixed(3) : null,
    overshoot_pct: +overshoot.toFixed(2),
    iae: +iae.toFixed(2),
    steady_state_error_rpm: +(r - ss).toFixed(2),
  };
}

// Draw a recorded run (ref / speed / PWM / twin) onto a canvas, black scope style.
function drawRecord(canvas: HTMLCanvasElement, rec: { ref: number; output: number; input: number; twin?: number }[]) {
  const ctx = canvas.getContext('2d');
  if (!ctx || rec.length < 2) return;
  const w = canvas.width, h = canvas.height, pad = 12;
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = '#222';
  for (let i = 0; i <= 10; i++) { const x = (w / 10) * i; ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke(); }
  for (let i = 0; i <= 6; i++) { const y = (h / 6) * i; ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke(); }
  const ymax = Math.max(300, ...rec.map(p => Math.max(p.ref, p.output)));
  const X = (i: number) => pad + (i / (rec.length - 1)) * (w - 2 * pad);
  const Y = (v: number) => h - pad - (v / ymax) * (h - 2 * pad);
  const line = (color: string, f: (p: typeof rec[number]) => number, width = 1.5) => {
    ctx.strokeStyle = color; ctx.lineWidth = width; ctx.beginPath();
    rec.forEach((p, i) => (i ? ctx.lineTo(X(i), Y(f(p))) : ctx.moveTo(X(i), Y(f(p)))));
    ctx.stroke();
  };
  line('#FFFF00', p => p.ref);
  line('#FF00FF', p => (p.input / 255) * 200, 1);
  if (rec.some(p => p.twin)) line('#00E5FF', p => p.twin || 0, 1);
  line('#00FF00', p => p.output, 2);
  ctx.fillStyle = '#FFF'; ctx.font = '10px monospace';
  ctx.fillText(`ref (yellow)  speed (green)  PWM x200/255 (magenta)  twin (cyan)   ${(rec.length / 100).toFixed(1)} s`, 14, 14);
}

function download(name: string, text: string, type: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// Loop analysis for plant G(s) = K e^{-sL} / (tau s + 1) under PI control C(s) = Kp + Ki/s.
function loopAnalysis(K: number, tau: number, L: number, kp: number, ki: number) {
  const pts: { w: number; plantDb: number; plantPh: number; loopDb: number; loopPh: number }[] = [];
  for (let i = 0; i <= 600; i++) {
    const w = Math.pow(10, -1 + (i / 600) * 4);          // 0.1 .. 1000 rad/s
    const gMag = K / Math.hypot(1, w * tau);
    const gPh = -Math.atan(w * tau) - w * L;
    const cMag = Math.hypot(kp, ki / w);
    const cPh = Math.atan2(-ki / w, kp);
    pts.push({ w, plantDb: 20 * Math.log10(gMag), plantPh: gPh * 180 / Math.PI,
               loopDb: 20 * Math.log10(gMag * cMag), loopPh: (gPh + cPh) * 180 / Math.PI });
  }
  let pm: number | null = null, wc: number | null = null, gm: number | null = null, w180: number | null = null, bw: number | null = null;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    if (wc === null && a.loopDb >= 0 && b.loopDb < 0) { wc = b.w; pm = 180 + b.loopPh; }
    if (w180 === null && a.loopPh > -180 && b.loopPh <= -180) { w180 = b.w; gm = -b.loopDb; }
  }
  // closed-loop -3 dB bandwidth from |T| = |L / (1 + L)|
  for (const p of pts) {
    const lm = Math.pow(10, p.loopDb / 20), ph = p.loopPh * Math.PI / 180;
    const re = lm * Math.cos(ph), im = lm * Math.sin(ph);
    const t = lm / Math.hypot(1 + re, im);
    if (t < Math.SQRT1_2) { bw = p.w; break; }
  }
  // closed-loop poles without the delay: s^2 + ((1 + K Kp)/tau) s + K Ki / tau = 0
  const a1 = (1 + K * kp) / tau, a0 = K * ki / tau, disc = a1 * a1 - 4 * a0;
  const poles = disc >= 0
    ? [[(-a1 + Math.sqrt(disc)) / 2, 0], [(-a1 - Math.sqrt(disc)) / 2, 0]]
    : [[-a1 / 2, Math.sqrt(-disc) / 2], [-a1 / 2, -Math.sqrt(-disc) / 2]];
  const wn = Math.sqrt(a0), zeta = a1 / (2 * wn);
  return { pts, pm, wc, gm, w180, bw, poles, wn, zeta };
}

export default function App() {
  const [activeTab, setActiveTab] = useState<'Dashboard' | 'Digital Twin' | 'System ID' | 'Controller' | 'AI Workspace' | 'Faults' | 'Settings' | 'Frequency' | 'State Space' | 'Reports' | 'Runs'>('Dashboard');
  // Defaults validated on the bench motor: settles in ~0.6 s with no overshoot (PI, no D).
  const [kp, setKp] = useState<number>(0.2);
  const [ki, setKi] = useState<number>(4.4);
  const [kd, setKd] = useState<number>(0.0);
  const [targetSpeed, setTargetSpeed] = useState<number>(150); // RPM
  const [controllerMode, setControllerMode] = useState<'PID' | 'Manual' | 'Adaptive AI'>('PID');
  const [excitationSignal, setExcitationSignal] = useState<'None' | 'Step' | 'Sine Sweep' | 'Chirp' | 'Impulse'>('None');
  
  // Real-time Telemetry Data State
  const [fault, setFault] = useState<string>('NOMINAL');
  const [telemetry, setTelemetry] = useState<TelemetryPoint[]>([]);
  const latest = telemetry.length > 0 ? telemetry[telemetry.length - 1] : undefined;
  // Live model learned on the ESP32 (falls back to the simulator's nominal plant).
  const edgeId = latest && latest.idK !== undefined ? latest : undefined;
  // Learned on the ESP32 when available; otherwise the simulator's plant (bench-identified N20).
  const plantK = edgeId?.idOk ? edgeId.idK! : 1.2;
  const plantTau = edgeId?.idOk ? edgeId.idTau! : 0.06;
  const plantDelay = edgeId?.idOk ? (edgeId.idD ?? 3) : 3;          // samples of 10 ms
  // Gains actually applied on the ESP32 (Adaptive AI uses its own); sliders otherwise / in simulation.
  const appliedFromEsp = latest?.gKp !== undefined && (latest.gKp! > 0 || latest.gKi! > 0);
  const gainsInUse = appliedFromEsp
    ? { kp: latest!.gKp!, ki: latest!.gKi!, kd: latest!.gKd ?? 0 }
    : { kp: 0, ki: 0, kd: 0 };
  const recentErr = telemetry.slice(-200);
  const meanAbsError = recentErr.length ? recentErr.reduce((a, p) => a + Math.abs(p.error), 0) / recentErr.length : 0;
  const trackingStatus = !latest ? 'NO DATA'
    : (fault !== 'NOMINAL' ? fault
      : latest.ref < 1 ? 'IDLE'
      : (telemetry.slice(-100).every(p => Math.abs(p.error) <= Math.max(2, 0.02 * p.ref)) ? 'STABLE' : 'SETTLING'));
  const supplyEstimate = edgeId?.idOk ? 12 * edgeId.idK! / K_AT_12V : null;
  const latestRef = useRef<TelemetryPoint | undefined>(undefined);
  latestRef.current = latest;   // read by the 3D animation loop without rebuilding the scene
  const anaKp = appliedFromEsp ? gainsInUse.kp : kp;
  const anaKi = appliedFromEsp ? gainsInUse.ki : ki;
  const analysis = useMemo(
    () => loopAnalysis(plantK, plantTau, plantDelay * 0.01, anaKp, anaKi),
    // recompute only when something changes by a visible amount
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [plantK.toFixed(3), plantTau.toFixed(3), plantDelay, anaKp.toFixed(3), anaKi.toFixed(3)]
  );
  const [isPlaying, setIsPlaying] = useState<boolean>(true);   // display stream (the link stays up)
  const isPlayingRef = useRef(true);
  const [isConnected, setIsConnected] = useState<boolean>(false);
  const [isEStop, setIsEStop] = useState<boolean>(false);
  const [samplingRate, setSamplingRate] = useState<number>(0);  // measured packets/s
  const [latency, setLatency] = useState<number | null>(null);  // measured WebSocket round trip, ms
  const [tunerSource, setTunerSource] = useState<'nn' | 'lambda'>('nn');
  const wsRef = useRef<WebSocket | null>(null);
  const recordRef = useRef<TelemetryPoint[]>([]);               // last RECORD_SECONDS of samples
  const [hw, setHw] = useState<HardwareInfo | null>(null);
  const [nnReport, setNnReport] = useState<NnReport | null>(null);
  const [simTune, setSimTune] = useState<{ neural: any; lambda: any } | null>(null);
  const [idResult, setIdResult] = useState<IdResult | null>(null);
  const [idBusy, setIdBusy] = useState(false);
  const [runs, setRuns] = useState<SavedRun[]>([]);
  const [selectedRun, setSelectedRun] = useState<SavedRun | null>(null);
  const [operator, setOperator] = useState('Pratik Kumar');
  const [reportTitle, setReportTitle] = useState('N20 Closed-loop speed tracking analysis');
  const [alarms, setAlarms] = useState<AlarmEvent[]>([]);
  const lastAlarmRef = useRef<{ fault: string; acl: string }>({ fault: 'NOMINAL', acl: '' });
  const runCanvasRef = useRef<HTMLCanvasElement>(null);

  // Terminal logs state
  const [logs, setLogs] = useState<string[]>([
    `[${new Date().toTimeString().split(' ')[0]}] SYSTEM: Dashboard started. Connecting to backend at ${API}…`
  ]);

  const logsEndRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const bodeCanvasRef = useRef<HTMLCanvasElement>(null);
  const simulationRef = useRef<{
    currentSpeed: number;
    integral: number;
    lastError: number;
    temp: number;
    trueSpeed: number;
    uBuf: number[];
  }>({ currentSpeed: 0, integral: 0, lastError: 0, temp: 28.5, trueSpeed: 0, uBuf: [] });

  // Add terminal log helper
  const addLog = (msg: string) => {
    const timestamp = new Date().toTimeString().split(' ')[0];
    setLogs(prev => [...prev, `[${timestamp}] ${msg}`]);
  };

  // Scroll logs to bottom
  useEffect(() => {
    if (logsEndRef.current) {
      logsEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [logs]);

  // Keep latest parameters in a mutable Ref to prevent simulation loop recreation
  const controlsRef = useRef({
    kp,
    ki,
    kd,
    targetSpeed,
    controllerMode,
    excitationSignal,
    isEStop
  });

  const tunerRef = useRef<'nn' | 'lambda'>('nn');
  useEffect(() => { tunerRef.current = tunerSource; }, [tunerSource]);

  useEffect(() => {
    controlsRef.current = {
      kp,
      ki,
      kd,
      targetSpeed,
      controllerMode,
      excitationSignal,
      isEStop
    };
  }, [kp, ki, kd, targetSpeed, controllerMode, excitationSignal, isEStop]);

  // Sync inputs to the backend/ESP32 whenever a control changes
  useEffect(() => {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({
        kp, ki, kd, targetSpeed, controllerMode, excitationSignal, isEStop, tuner: tunerSource
      }));
    }
  }, [kp, ki, kd, targetSpeed, controllerMode, excitationSignal, isEStop, tunerSource]);

  useEffect(() => { isPlayingRef.current = isPlaying; }, [isPlaying]);

  // One-shot commands to the ESP32 (relearn model, relearn anomaly baseline)
  const sendCommand = (cmd: string, label: string) => {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ cmd }));
      addLog(label);
    } else {
      addLog("HARDWARE: not connected to the ESP32; command not sent.");
    }
  };

  // WebSocket link with auto-reconnect; the local simulator only runs while the backend is offline.
  useEffect(() => {
    let intervalId: ReturnType<typeof setInterval> | undefined;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let ws: WebSocket | null = null;
    let stopped = false;
    let wasConnected = false;
    let packets = 0;
    let timeIndex = 0;

    // Samples are recorded immediately; the display is refreshed in batches at 25 Hz so React
    // re-renders 25 times a second instead of once per 100 Hz sample.
    let pending: TelemetryPoint[] = [];
    const pushPoint = (pt: TelemetryPoint) => {
      const rec = recordRef.current;
      rec.push(pt);
      if (rec.length > RECORD_SECONDS * 100) rec.splice(0, rec.length - RECORD_SECONDS * 100);
      if (isPlayingRef.current) pending.push(pt);   // display paused: keep recording, freeze plots
    };
    const flushTimer = setInterval(() => {
      if (!pending.length) return;
      const batch = pending;
      pending = [];
      setTelemetry(prev => {
        const updated = prev.concat(batch);
        return updated.length > 250 ? updated.slice(updated.length - 250) : updated;
      });
    }, 40);

    const noteAlarms = (f: string, acl: string | undefined) => {
      const last = lastAlarmRef.current;
      const t = new Date().toTimeString().split(' ')[0];
      if (f !== last.fault) {
        const msg: Record<string, string> = {
          OVERCURRENT: 'Motor current exceeded the limit (>1.2 A for 200 ms or >2.0 A peak). Motor cut, latched.',
          OVERHEAT: 'Motor temperature exceeded 58 °C. Motor cut, latched.',
          STALL: 'Stall: high PWM with the rotor below 15 RPM for 0.5 s. Motor cut, latched.',
          ESTOP: 'Emergency stop active. PWM forced to 0.',
          IDLE: 'Motor idle (waiting for a command).',
          NOMINAL: 'Controller running normally.',
        };
        setAlarms(a => [{ t, kind: f, detail: msg[f] ?? f }, ...a].slice(0, 50));
        if (f !== 'IDLE') addLog(`${f === 'NOMINAL' ? 'STATE' : 'ALARM'}: ${msg[f] ?? f}`);
        last.fault = f;
      }
      if (acl && acl !== last.acl) {
        if (last.acl && acl !== 'LEARNING') {
          const d: Record<string, string> = {
            NORMAL: 'Behaviour back within the learned healthy baseline.',
            LOAD: 'Mechanical load: slower than the digital twin and/or drawing more current.',
            DRIVE_LOSS: 'Drive loss: slower than the twin without extra current (supply sag / driver).',
            OVERSPEED: 'Faster than the twin: load released or model mismatch.',
            VIBRATION: 'Vibration above the healthy baseline for this speed (bearing / imbalance).',
            DRIFT: 'Motor gain has drifted from the healthy baseline (persistent load or supply change).',
            THERMAL: 'Motor temperature approaching the overheat limit.',
          };
          setAlarms(a => [{ t, kind: `ANOMALY ${acl}`, detail: d[acl] ?? acl }, ...a].slice(0, 50));
          addLog(`AI ANOMALY: ${acl}. ${d[acl] ?? ''}`);
        }
        last.acl = acl;
      }
    };

    const fetchBackendInfo = () => {
      fetch(`${API}/api/hardware`).then(r => r.json()).then((h: HardwareInfo) => {
        setHw(h);
        if (h.mode === 'hardware' && h.info?.sensors) {
          const sn = h.info.sensors;
          addLog(`HARDWARE: ESP32-S3 on ${h.port} @ ${h.baud} baud, firmware ${h.info.fw}.`);
          addLog(`SENSORS: I2C bus: OLED(0x3C) ${sn.oled ? 'OK' : 'MISSING'}, INA219(0x40) ${sn.ina219 ? 'OK' : 'MISSING'}, MPU6050(0x68) ${sn.mpu6050 ? 'OK' : 'MISSING'}.`);
          addLog(`STATE: Controller running on the ESP32 at ${h.info.control_hz} Hz, PWM ${h.info.pwm_hz / 1000} kHz.`);
        } else if (h.mode === 'simulator') {
          addLog('HARDWARE: Backend is in simulator mode (no ESP32 configured).');
        }
      }).catch(() => {});
      fetch(`${API}/api/nn_info`).then(r => r.json()).then(setNnReport).catch(() => {});
    };

    const connectWS = () => {
      if (stopped) return;
      ws = new WebSocket('ws://localhost:8088/ws');
      wsRef.current = ws;

      ws.onopen = () => {
        if (wsRef.current !== ws) return;
        if (intervalId) { clearInterval(intervalId); intervalId = undefined; }
        wasConnected = true;
        setIsConnected(true);
        addLog("HARDWARE: Connected to the backend on port 8088.");
        ws?.send(JSON.stringify({ ...controlsRef.current, tuner: tunerRef.current }));
        fetchBackendInfo();
      };

      ws.onmessage = (event) => {
        if (wsRef.current !== ws) return;
        try {
          const packet = JSON.parse(event.data);
          if (packet.pong !== undefined) { setLatency(performance.now() - packet.pong); return; }
          if (packet.log !== undefined) { addLog(`ESP32: ${packet.log}`); return; }
          const currentFault = packet.fault || 'NOMINAL';
          setFault(currentFault);
          packets++;
          pushPoint(packet as TelemetryPoint);
          noteAlarms(currentFault, packet.acl);
        } catch (e) {
          console.error("Failed to parse websocket telemetry: ", e);
        }
      };

      ws.onerror = () => { /* onclose handles it */ };

      ws.onclose = () => {
        if (stopped || wsRef.current !== ws) return;
        setIsConnected(false);
        wsRef.current = null;
        if (wasConnected) addLog("HARDWARE: Backend connection lost. Running the local simulator; retrying every 3 s.");
        wasConnected = false;
        startLocalSimulation();
        retryTimer = setTimeout(connectWS, 3000);
      };
    };

    const startLocalSimulation = () => {
      if (intervalId) return;
      intervalId = setInterval(() => {
        const state = simulationRef.current;
        const currentControls = controlsRef.current;

        if (currentControls.isEStop) {
          state.currentSpeed = 0;
          state.trueSpeed = 0;
          state.uBuf = [];
          state.integral = 0;
          state.lastError = 0;
          state.temp += (28.5 - state.temp) * 0.01 / 240;
          setFault('ESTOP');
          packets++;
          pushPoint({ time: timeIndex * 0.01, ref: 0, output: 0, input: 0, error: 0, current: 0,
                      temp: parseFloat(state.temp.toFixed(2)) });
          timeIndex++;
          return;
        }

        // Target computation with excitation
        let currentTarget = currentControls.targetSpeed;
        if (currentControls.excitationSignal === 'Step') {
          currentTarget = Math.floor(timeIndex / 100) % 2 === 0 ? 50 : currentControls.targetSpeed;
        } else if (currentControls.excitationSignal === 'Sine Sweep') {
          const freq = 0.2 + (timeIndex / 500);
          currentTarget = currentControls.targetSpeed + Math.sin(timeIndex * 0.05 * freq) * 40;
        } else if (currentControls.excitationSignal === 'Impulse') {
          currentTarget = timeIndex % 200 === 0 ? currentControls.targetSpeed + 100 : currentControls.targetSpeed;
        }

        // Controller: same law as the firmware (D on measurement, integrator held while saturated)
        let controlPWM = 0;
        const error = currentTarget - state.currentSpeed;
        if (currentControls.controllerMode === 'PID' || currentControls.controllerMode === 'Adaptive AI') {
          // Adaptive AI offline: the neural-tuner gains for this simulated plant (backend-verified)
          const adaptive = currentControls.controllerMode === 'Adaptive AI';
          const gkp = adaptive ? 0.47 : currentControls.kp;
          const gki = adaptive ? 10.4 : currentControls.ki;
          const gkd = adaptive ? 0 : currentControls.kd;
          const dRpm = (state.currentSpeed - state.lastError) / 0.01;   // lastError holds the last speed
          const unsat = gkp * error + gki * (state.integral + error * 0.01) - gkd * dRpm;
          if (!((unsat > 255 && error > 0) || (unsat < 0 && error < 0)))
            state.integral = Math.max(-400, Math.min(400, state.integral + error * 0.01));
          controlPWM = gkp * error + gki * state.integral - gkd * dRpm;
          state.lastError = state.currentSpeed;
        } else {
          controlPWM = currentControls.targetSpeed * 0.6;
        }
        controlPWM = Math.max(0, Math.min(255, controlPWM));

        // Plant: the JGA12-N20 as identified on the bench (K 1.2 RPM/PWM, tau 60 ms, 30 ms delay)
        state.uBuf.push(controlPWM);
        const uDelayed = state.uBuf.length > 3 ? state.uBuf.shift()! : 0;
        const a = Math.exp(-0.01 / 0.06);
        state.trueSpeed = a * state.trueSpeed + (1 - a) * 1.2 * uDelayed;
        state.currentSpeed = Math.max(0, state.trueSpeed + (Math.random() - 0.5) * 0.6);

        // Current (no-load N20: ~0.03-0.15 A) and the firmware's thermal model
        const motorCurrent = Math.max(0, 0.03 + 0.11 * (controlPWM / 255) + (Math.random() - 0.5) * 0.01);
        const powerW = motorCurrent * motorCurrent * 40 + 0.1 * state.currentSpeed / 300;
        const targetC = 28.5 + powerW * 25;
        state.temp += (targetC - state.temp) * 0.01 / (targetC > state.temp ? 90 : 240);

        let localFault = 'NOMINAL';
        if (motorCurrent > 1.2) localFault = 'OVERCURRENT';
        else if (state.temp > 58) localFault = 'OVERHEAT';
        else if (controlPWM > 150 && state.currentSpeed < 15) localFault = 'STALL';
        setFault(localFault);
        packets++;
        pushPoint({
          time: timeIndex * 0.01,
          ref: currentTarget,
          output: parseFloat(state.currentSpeed.toFixed(2)),
          input: parseFloat(controlPWM.toFixed(1)),
          error: parseFloat(error.toFixed(2)),
          current: parseFloat(motorCurrent.toFixed(3)),
          temp: parseFloat(state.temp.toFixed(2))
        });
        timeIndex++;
      }, 10);
    };

    const pingTimer = setInterval(() => {
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ ping: performance.now() }));
    }, 2000);
    const rateTimer = setInterval(() => { setSamplingRate(packets); packets = 0; }, 1000);
    const hwTimer = setInterval(() => {
      if (ws && ws.readyState === WebSocket.OPEN) fetch(`${API}/api/hardware`).then(r => r.json()).then(setHw).catch(() => {});
    }, 5000);

    connectWS();

    return () => {
      stopped = true;
      if (ws) ws.close();
      if (intervalId) clearInterval(intervalId);
      if (retryTimer) clearTimeout(retryTimer);
      clearInterval(pingTimer);
      clearInterval(rateTimer);
      clearInterval(hwTimer);
      clearInterval(flushTimer);
    };
  }, []);

  // Render Time-Series Chart on HTML5 Canvas (Oscilloscope Widget)
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || telemetry.length === 0) return;
    
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const width = canvas.width;
    const height = canvas.height;

    // Clear Canvas with Oscilloscope black background
    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, width, height);

    // Draw Grid Lines (Industrial Grid)
    ctx.strokeStyle = '#222222';
    ctx.lineWidth = 1;
    
    // Vertical grid divisions (Time axis)
    const divisionsX = 10;
    for (let i = 0; i <= divisionsX; i++) {
      const x = (width / divisionsX) * i;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, height);
      ctx.stroke();
    }

    // Horizontal grid divisions (RPM axis)
    const divisionsY = 8;
    for (let i = 0; i <= divisionsY; i++) {
      const y = (height / divisionsY) * i;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(width, y);
      ctx.stroke();
    }

    // Grid center ticks
    ctx.strokeStyle = '#444444';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(width / 2, 0); ctx.lineTo(width / 2, height);
    ctx.moveTo(0, height / 2); ctx.lineTo(width, height / 2);
    ctx.stroke();

    // Scale mappings
    const maxRPM = 300;
    const minRPM = 0;
    const padding = 15;

    const getX = (index: number) => {
      return (index / 250) * (width - padding * 2) + padding;
    };

    const getY = (val: number) => {
      const ratio = (val - minRPM) / (maxRPM - minRPM);
      return height - (ratio * (height - padding * 2) + padding);
    };

    // Draw Setpoint reference curve (Yellow)
    ctx.strokeStyle = '#FFFF00';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    telemetry.forEach((pt, idx) => {
      const x = getX(idx);
      const y = getY(pt.ref);
      if (idx === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();

    // Draw Actual Process Speed output curve (Bright Green)
    ctx.strokeStyle = '#00FF00';
    ctx.lineWidth = 2;
    ctx.beginPath();
    telemetry.forEach((pt, idx) => {
      const x = getX(idx);
      const y = getY(pt.output);
      if (idx === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();

    // Digital-twin speed (Cyan): the ESP32's frozen healthy model driven by the same PWM
    if (telemetry.some(pt => pt.twin)) {
      ctx.strokeStyle = '#00E5FF';
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      telemetry.forEach((pt, idx) => {
        const x = getX(idx);
        const y = getY(pt.twin || 0);
        if (idx === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // Draw Control Signal (Red, scaled to display 0-255 inside 0-300 grid)
    ctx.strokeStyle = '#FF00FF';
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    telemetry.forEach((pt, idx) => {
      const x = getX(idx);
      const y = getY((pt.input / 255) * 200); // Scaled
      if (idx === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();

    // Draw Oscilloscope OSD text
    ctx.fillStyle = '#FFFFFF';
    ctx.font = '10px monospace';
    ctx.fillText("CH1 Ref (YEL)   : Dynamic Target", 15, 20);
    ctx.fillText("CH2 Speed (GRN) : RPM Telemetry", 15, 32);
    ctx.fillText("CH3 PWM (MAG)   : Control Output", 15, 44);
    if (telemetry.some(pt => pt.twin)) {
      ctx.fillStyle = '#00E5FF';
      ctx.fillText("CH4 Twin (CYN)  : Digital-twin model", 15, 56);
    }

    const latest = telemetry[telemetry.length - 1];
    ctx.fillStyle = '#00FF00';
    ctx.fillText(`LATEST SPEED: ${latest.output.toFixed(1)} RPM`, width - 180, 20);
    ctx.fillStyle = '#FFFF00';
    ctx.fillText(`SETPOINT    : ${latest.ref} RPM`, width - 180, 32);
    ctx.fillStyle = '#FF00FF';
    ctx.fillText(`PWM         : ${latest.input.toFixed(0)} / 255`, width - 180, 44);
  }, [telemetry]);

  // Bode plot: plant (learned model) and open loop with the gains in use, redrawn when they change
  useEffect(() => {
    const canvas = bodeCanvasRef.current;
    if (!canvas || activeTab !== 'Frequency') return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const width = canvas.width, height = canvas.height;
    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, width, height);

    const xOf = (w: number) => ((Math.log10(w) + 1) / 4) * width;              // 0.1 .. 1000 rad/s
    const magTop = 60, magBot = -60;                                          // dB, upper half
    const phTop = 0, phBot = -270;                                            // deg, lower half
    const half = height / 2;
    const yMag = (db: number) => ((magTop - Math.max(magBot, Math.min(magTop, db))) / (magTop - magBot)) * (half - 10) + 5;
    const yPh = (deg: number) => half + ((phTop - Math.max(phBot, Math.min(phTop, deg))) / (phTop - phBot)) * (half - 20) + 5;

    ctx.strokeStyle = '#222222';
    ctx.lineWidth = 1;
    [0.1, 1, 10, 100, 1000].forEach(dec => {
      const x = xOf(dec);
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, height); ctx.stroke();
      ctx.fillStyle = '#888888'; ctx.font = '9px monospace';
      ctx.fillText(`${dec} rad/s`, x + 2, height - 4);
    });
    [40, 20, 0, -20, -40].forEach(db => {
      const y = yMag(db);
      ctx.strokeStyle = db === 0 ? '#555555' : '#222222';
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(width, y); ctx.stroke();
      ctx.fillStyle = '#777777'; ctx.fillText(`${db} dB`, 2, y - 2);
    });
    [-90, -180].forEach(deg => {
      const y = yPh(deg);
      ctx.strokeStyle = deg === -180 ? '#663300' : '#222222';
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(width, y); ctx.stroke();
      ctx.fillStyle = '#777777'; ctx.fillText(`${deg}°`, 2, y - 2);
    });
    ctx.strokeStyle = '#444444';
    ctx.beginPath(); ctx.moveTo(0, half); ctx.lineTo(width, half); ctx.stroke();

    const trace = (color: string, dash: number[], f: (p: typeof analysis.pts[number]) => number) => {
      ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.setLineDash(dash); ctx.beginPath();
      analysis.pts.forEach((p, i) => { const x = xOf(p.w), y = f(p); if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y); });
      ctx.stroke(); ctx.setLineDash([]);
    };
    trace('#00AAFF', [], p => yMag(p.plantDb));
    trace('#00FF66', [], p => yMag(p.loopDb));
    trace('#FFAA00', [4, 4], p => yPh(p.plantPh));
    trace('#FF5577', [4, 4], p => yPh(p.loopPh));
    if (analysis.wc) {
      ctx.strokeStyle = '#FFFFFF'; ctx.setLineDash([2, 3]);
      ctx.beginPath(); ctx.moveTo(xOf(analysis.wc), 0); ctx.lineTo(xOf(analysis.wc), height); ctx.stroke();
      ctx.setLineDash([]);
    }
    ctx.fillStyle = '#FFFFFF';
    ctx.font = '10px monospace';
    ctx.fillText("Plant |G| (BLUE)  Loop |CG| (GREEN)  |  Plant phase (ORANGE)  Loop phase (PINK)", 60, 14);
    ctx.fillText(`G(s) = ${plantK.toFixed(3)}·e^(-${(plantDelay * 0.01).toFixed(2)}s) / (${plantTau.toFixed(3)}s + 1)   C(s) = ${anaKp.toFixed(2)} + ${anaKi.toFixed(2)}/s`, 60, 28);
  }, [activeTab, analysis, plantK, plantTau, plantDelay, anaKp, anaKi]);

  // ---- actions behind the dashboard buttons ------------------------------------------------
  const runIdentification = () => {
    const rec = recordRef.current.slice(-3000).filter(p => p.input !== undefined);
    if (rec.length < 100) { addLog("SYSTEM ID: Not enough recorded data yet (need ~1 s)."); return; }
    setIdBusy(true);
    addLog(`SYSTEM ID: Least-squares fit (1st and 2nd order, delays 1-6) over ${rec.length} recorded samples…`);
    fetch(`${API}/api/identify`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ time: rec.map(p => p.time), input: rec.map(p => p.input), output: rec.map(p => p.output) }),
    }).then(r => r.json()).then((res: IdResult) => {
      setIdResult(res);
      if (res.status !== 'IDENTIFICATION_SUCCESS') addLog(`SYSTEM ID: ${res.message}`);
      else addLog(`SYSTEM ID: 1st order K=${res.first_order!.K.toFixed(3)}, tau=${(res.first_order!.tau * 1000).toFixed(0)} ms, delay=${res.first_order!.delay} (fit ${res.first_order!.fit_pct.toFixed(1)} %); 2nd order fit ${res.second_order!.fit_pct.toFixed(1)} %.`);
    }).catch(() => addLog("SYSTEM ID: backend unreachable.")).finally(() => setIdBusy(false));
  };

  const refreshRuns = () => {
    fetch(`${API}/api/runs`).then(r => r.json()).then(setRuns).catch(() => addLog("SQLITE: backend unreachable."));
  };

  const saveRun = () => {
    const rec = recordRef.current.slice(-2000);
    if (rec.length < 50) { addLog("SQLITE: Nothing recorded yet."); return; }
    const metrics = { ...(stepMetrics(rec) ?? {}), mean_abs_error_rpm: +meanAbsError.toFixed(2),
                      max_current_a: +Math.max(...rec.map(p => p.current)).toFixed(3),
                      max_temp_c: +Math.max(...rec.map(p => p.temp)).toFixed(2) };
    const body = {
      operator, title: reportTitle, source: isConnected && hw?.mode === 'hardware' ? 'ESP32-S3' : 'simulator',
      controller: latest?.mode ?? controllerMode,
      kp: appliedFromEsp ? gainsInUse.kp : kp, ki: appliedFromEsp ? gainsInUse.ki : ki, kd: appliedFromEsp ? gainsInUse.kd : kd,
      metrics,
      model: { K: plantK, tau: plantTau, delay: plantDelay, identified_on: edgeId?.idOk ? 'ESP32-S3 (RLS)' : 'nominal' },
      samples: rec.map(p => [p.time, p.ref, p.output, p.input, p.current, p.temp, p.twin ?? 0]),
    };
    fetch(`${API}/api/runs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      .then(r => r.json()).then(r => { addLog(`SQLITE: Saved run #${r.id} (${rec.length} samples).`); refreshRuns(); })
      .catch(() => addLog("SQLITE: backend unreachable."));
  };

  const loadRun = (id: number) => {
    fetch(`${API}/api/runs/${id}`).then(r => r.json()).then((run: SavedRun) => {
      setSelectedRun(run);
      addLog(`SQLITE: Loaded run #${run.id} "${run.title}".`);
    });
  };

  const deleteRun = (id: number) => {
    fetch(`${API}/api/runs/${id}`, { method: 'DELETE' }).then(() => {
      addLog(`SQLITE: Deleted run #${id}.`);
      if (selectedRun?.id === id) setSelectedRun(null);
      refreshRuns();
    });
  };

  useEffect(() => {
    if (selectedRun?.samples && runCanvasRef.current)
      drawRecord(runCanvasRef.current, selectedRun.samples.map(s => ({ ref: s[1], output: s[2], input: s[3], twin: s[6] })));
  }, [selectedRun, activeTab]);

  useEffect(() => { if (activeTab === 'Runs') refreshRuns(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [activeTab]);

  // In simulator mode, ask the backend's copy of the neural tuner for gains for the simulated plant.
  useEffect(() => {
    if (hw?.mode !== 'simulator') return;
    fetch(`${API}/api/autotune`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ gain: 1.2, time_constant: 0.06, delay: 3 }) })
      .then(r => r.json()).then(setSimTune).catch(() => {});
  }, [hw?.mode]);

  const exportCsv = () => {
    const rec = recordRef.current;
    if (!rec.length) { addLog("REPORT: Nothing recorded yet."); return; }
    const cols = ['time', 'ref', 'output', 'input', 'error', 'current', 'temp', 'vib', 'dist', 'twin', 'an', 'acl', 'idK', 'idTau', 'idD', 'gKp', 'gKi', 'gKd', 'fault'] as const;
    const lines = [cols.join(',')].concat(rec.map(p => cols.map(c => (p as any)[c] ?? '').join(',')));
    download(`controllab_run_${new Date().toISOString().replace(/[:.]/g, '-')}.csv`, lines.join('\n'), 'text/csv');
    addLog(`REPORT: Exported ${rec.length} samples (${(rec.length / 100).toFixed(1)} s) to CSV.`);
  };

  const reportData = () => {
    const rec = recordRef.current.slice(-2000);
    return {
      rec,
      metrics: stepMetrics(rec),
      gains: appliedFromEsp ? gainsInUse : { kp, ki, kd },
      mode: latest?.mode ?? controllerMode,
      source: isConnected && hw?.mode === 'hardware' ? `ESP32-S3 on ${hw.port}` : 'local simulator',
    };
  };

  const exportLatex = () => {
    const { metrics, gains, mode, source } = reportData();
    const m = metrics;
    const tex = `\\documentclass[conference]{IEEEtran}
\\usepackage{amsmath}
\\title{${reportTitle}}
\\author{${operator}}
\\begin{document}
\\maketitle
\\section{Plant model}
Identified on-line (${edgeId?.idOk ? 'recursive least squares on the ESP32-S3' : 'nominal model'}), source: ${source}.
\\begin{equation}
G(s) = \\frac{${plantK.toFixed(3)}\\, e^{-${(plantDelay * 0.01).toFixed(2)}s}}{${plantTau.toFixed(3)}s + 1}
\\end{equation}
\\section{Controller}
Mode: ${mode}. $K_p = ${gains.kp.toFixed(3)}$, $K_i = ${gains.ki.toFixed(3)}$, $K_d = ${gains.kd.toFixed(3)}$.
Phase margin ${analysis.pm !== null ? analysis.pm.toFixed(1) + '$^\\circ$' : 'n/a'}, gain margin ${analysis.gm !== null ? analysis.gm.toFixed(1) + ' dB' : '$\\infty$'},
closed-loop bandwidth ${analysis.bw !== null ? analysis.bw.toFixed(1) + ' rad/s' : 'n/a'}.
\\section{Step response}
${m ? `Step ${m.from_rpm} $\\to$ ${m.to_rpm} RPM: rise time ${m.rise_time_s ?? 'n/a'} s, settling time (2\\%) ${m.settling_time_s ?? 'n/a'} s, overshoot ${m.overshoot_pct}\\%, IAE ${m.iae}, steady-state error ${m.steady_state_error_rpm} RPM.` : 'No setpoint step in the recorded window.'}
\\end{document}
`;
    download('IEEE_draft.tex', tex, 'application/x-tex');
    addLog("REPORT: Exported IEEE LaTeX draft with the live model, gains and step metrics.");
  };

  const printReport = () => {
    const { rec, metrics, gains, mode, source } = reportData();
    const c = document.createElement('canvas');
    c.width = 900; c.height = 280;
    drawRecord(c, rec);
    const row = (k: string, v: string) => `<tr><th style="text-align:left;padding:4px 10px;border:1px solid #ccc">${k}</th><td style="padding:4px 10px;border:1px solid #ccc">${v}</td></tr>`;
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>${reportTitle}</title></head>
<body style="font-family:Helvetica,Arial,sans-serif;margin:30px;color:#111">
<h2 style="margin:0">${reportTitle}</h2>
<div style="color:#555;margin:4px 0 16px">${operator} · ${new Date().toLocaleString()} · ${source}</div>
<img src="${c.toDataURL()}" style="width:100%;border:1px solid #999">
<h3>Plant model</h3><table style="border-collapse:collapse">
${row('Transfer function', `G(s) = ${plantK.toFixed(3)} e^(-${(plantDelay * 0.01).toFixed(2)}s) / (${plantTau.toFixed(3)}s + 1)`)}
${row('Identified by', edgeId?.idOk ? `ESP32-S3 online RLS (${edgeId.idN} informative samples)` : 'nominal model')}
</table>
<h3>Controller</h3><table style="border-collapse:collapse">
${row('Mode', mode)}${row('Gains', `Kp ${gains.kp.toFixed(3)}, Ki ${gains.ki.toFixed(3)}, Kd ${gains.kd.toFixed(3)}`)}
${row('Phase margin', analysis.pm !== null ? analysis.pm.toFixed(1) + '°' : 'n/a')}
${row('Gain margin', analysis.gm !== null ? analysis.gm.toFixed(1) + ' dB' : '∞')}
${row('Closed-loop bandwidth', analysis.bw !== null ? analysis.bw.toFixed(1) + ' rad/s' : 'n/a')}
</table>
<h3>Last step response</h3><table style="border-collapse:collapse">
${metrics ? Object.entries(metrics).map(([k, v]) => row(k.replace(/_/g, ' '), String(v ?? 'n/a'))).join('') : row('—', 'No setpoint step in the recorded window')}
${row('Mean |error| (last 2 s)', meanAbsError.toFixed(2) + ' RPM')}
</table>
<h3>Alarms</h3><table style="border-collapse:collapse">
${alarms.length ? alarms.slice(0, 15).map(a => row(a.t + ' ' + a.kind, a.detail)).join('') : row('—', 'none')}
</table>
<script>window.onload = () => window.print();</script></body></html>`;
    const win = window.open('', '_blank');
    if (!win) { addLog("REPORT: Pop-up blocked; allow pop-ups to print the report."); return; }
    win.document.write(html);
    win.document.close();
    addLog("REPORT: Opened the printable report (use Save as PDF in the print dialog).");
  };

  // Start step test trigger
  const triggerStepTest = () => {
    addLog(`EXCITATION: Square-wave steps 50 <-> ${targetSpeed} RPM every 1 s for 8 s.`);
    setExcitationSignal('Step');
    setTimeout(() => {
      setExcitationSignal('None');
      addLog("EXCITATION: Step sequence complete.");
    }, 8000);
  };

  return (
    <div className="app-container">
      {/* 1. TOP TOOLBAR (MATLAB/TIA Portal Ribbon style) */}
      <header className="app-toolbar">
        <div className="toolbar-section">
          <div className="toolbar-title">
            <Activity size={16} />
            <span>EdgeAI ControlLab v1.0.0</span>
          </div>
          <span className="status-indicator">
            <span className={`status-dot ${
              isEStop || fault === 'ESTOP' ? 'red' :
              fault === 'OVERCURRENT' ? 'red' :
              fault === 'OVERHEAT' || fault === 'STALL' ? 'yellow' :
              isConnected ? 'green' : 'grey'
            }`}></span>
            <span style={{ fontWeight: 'bold' }}>
              {isEStop || fault === 'ESTOP' ? 'ESTOP TRIPPED' :
               fault === 'OVERCURRENT' ? 'OVERCURRENT ALARM' :
               fault === 'OVERHEAT' ? 'OVERHEAT WARNING' :
               fault === 'STALL' ? 'MOTOR STALLED' :
               isConnected ? 'LIVE ONLINE' : 'LOCAL SIMULATOR'}
            </span>
          </span>
          <div style={{ height: 16, width: 1, backgroundColor: '#D9D9D9', margin: '0 8px' }}></div>
          <span style={{ color: 'var(--color-text-muted)', fontSize: 11 }}>Active Target: N20 Encoder DC Motor ({!isConnected ? 'Local Sim' : hw?.mode === 'hardware' ? 'ESP32-S3' : 'Backend Simulator'})</span>
        </div>
        
        <div className="toolbar-section">
          <button
            className={`btn-industrial ${isEStop ? 'success' : 'danger'}`}
            onClick={() => {
              setIsEStop(!isEStop);
              addLog(isEStop
                ? "SAFETY: Manual Emergency Stop reset. Resuming plant operations."
                : "SAFETY: Manual Emergency Stop triggered. Motor output disabled.");
            }}
          >
            <Square size={11} /> {isEStop ? 'START MOTOR' : 'STOP MOTOR'}
          </button>
          <button className="btn-industrial primary" onClick={triggerStepTest}>
            <Play size={11} /> Run Excitation Step
          </button>
          <button 
            className="btn-industrial" 
            onClick={() => {
              setIsPlaying(!isPlaying);
              addLog(isPlaying ? "STATE: Display paused (recording and motor control continue)." : "STATE: Display resumed.");
            }}
          >
            {isPlaying ? <Square size={11} /> : <Play size={11} />}
            {isPlaying ? "Pause Display" : "Resume Display"}
          </button>
          <button 
            className="btn-industrial" 
            onClick={() => {
              setTelemetry([]);
              addLog("STATE: Cleared telemetry plot history.");
            }}
          >
            <RefreshCw size={11} /> Clear Plots
          </button>
        </div>
      </header>

      {/* 2. APP MAIN WORKSPACE AND LAYOUT */}
      <div className="app-body">
        
        {/* Left Navigation (Dark Industrial Theme) */}
        <aside className="app-sidebar">
          <div className="sidebar-header">Core Instrumentation</div>
          <div className={`sidebar-menu-item ${activeTab === 'Dashboard' ? 'active' : ''}`} onClick={() => setActiveTab('Dashboard')}>
            <Cpu size={14} /> Dashboard Overview
          </div>
          <div className={`sidebar-menu-item ${activeTab === 'Digital Twin' ? 'active' : ''}`} onClick={() => setActiveTab('Digital Twin')}>
            <Disc size={14} /> Digital Twin 3D
          </div>
          <div className={`sidebar-menu-item ${activeTab === 'System ID' ? 'active' : ''}`} onClick={() => setActiveTab('System ID')}>
            <BarChart2 size={14} /> System Identification
          </div>
          <div className={`sidebar-menu-item ${activeTab === 'Controller' ? 'active' : ''}`} onClick={() => setActiveTab('Controller')}>
            <Sliders size={14} /> Controller Tuning
          </div>
          <div className={`sidebar-menu-item ${activeTab === 'AI Workspace' ? 'active' : ''}`} onClick={() => setActiveTab('AI Workspace')}>
            <Binary size={14} /> AI Predictor Panel
          </div>
          <div className={`sidebar-menu-item ${activeTab === 'Faults' ? 'active' : ''}`} onClick={() => setActiveTab('Faults')}>
            <ShieldAlert size={14} /> Fault Alarms
          </div>
          <div className={`sidebar-menu-item ${activeTab === 'Frequency' ? 'active' : ''}`} onClick={() => setActiveTab('Frequency')}>
            <Activity size={14} /> Frequency Response
          </div>
          <div className={`sidebar-menu-item ${activeTab === 'State Space' ? 'active' : ''}`} onClick={() => setActiveTab('State Space')}>
            <Sliders size={14} /> State Space model
          </div>
          
          <div className="sidebar-header" style={{ marginTop: 15 }}>Laboratory Records</div>
          <div className={`sidebar-menu-item ${activeTab === 'Runs' ? 'active' : ''}`} onClick={() => setActiveTab('Runs')}><Database size={14} /> Saved Runs (SQLite)</div>
          <div className={`sidebar-menu-item ${activeTab === 'Reports' ? 'active' : ''}`} onClick={() => setActiveTab('Reports')}>
            <FileText size={14} /> Export Reports
          </div>
          <div className={`sidebar-menu-item ${activeTab === 'Settings' ? 'active' : ''}`} onClick={() => setActiveTab('Settings')}>
            <Settings size={14} /> Workspace Config
          </div>
        </aside>

        {/* Main Working Panel */}
        <main className="app-workspace">
          <div className="workspace-content">
            
            {/* Real-time Scope Panel (Visible in Dashboard and Tuning sections) */}
            {(activeTab === 'Dashboard' || activeTab === 'Controller') && (
              <div className="panel" style={{ height: '300px' }}>
                <div className="panel-header">
                  <span>REAL-TIME OSCILLOSCOPE FEED</span>
                  <span className="status-indicator">
                    <span className="status-dot green"></span>
                    <span>{samplingRate} samples/sec{!isPlaying ? ' · DISPLAY PAUSED' : ''}</span>
                  </span>
                </div>
                <div className="panel-body" style={{ padding: 0, backgroundColor: '#000000', overflow: 'hidden' }}>
                  <canvas ref={canvasRef} width={800} height={270} style={{ width: '100%', height: '100%', display: 'block' }}></canvas>
                </div>
              </div>
            )}

            {/* TAB CONTENT: DASHBOARD OVERVIEW */}
            {activeTab === 'Dashboard' && (
              <div className="grid-3">
                {/* Telemetry Status Grid */}
                <div className="panel">
                  <div className="panel-header">SCADA RUNTIME METRICS</div>
                  <div className="panel-body">
                    <table className="table-dense">
                      <tbody>
                        <tr>
                          <th>Active Controller</th>
                          <td style={{ color: 'var(--color-accent)', fontWeight: 'bold' }}>
                            {latest?.mode ?? controllerMode} Loop
                            {latest?.mode === 'Adaptive AI' && edgeId?.idOk ? ` (${latest.tun === 'lambda' ? 'lambda rule' : 'neural tuner'})` : ''}
                          </td>
                        </tr>
                        <tr>
                          <th>Gains In Use</th>
                          <td style={{ fontFamily: 'monospace' }}>
                            {(() => { const g = appliedFromEsp ? gainsInUse : { kp, ki, kd }; return `Kp ${g.kp.toFixed(2)} · Ki ${g.ki.toFixed(2)} · Kd ${g.kd.toFixed(2)}`; })()}
                          </td>
                        </tr>
                        <tr>
                          <th>Telemetry Rate</th>
                          <td>{samplingRate} Hz</td>
                        </tr>
                        <tr>
                          <th>Link Latency (round trip)</th>
                          <td>{latency !== null && isConnected ? `${latency.toFixed(1)} ms` : '—'}</td>
                        </tr>
                        <tr>
                          <th>Current Draw (INA219)</th>
                          <td>{latest ? latest.current.toFixed(3) : '0.000'} A</td>
                        </tr>
                        <tr>
                          <th>Winding Temperature</th>
                          <td>{latest ? latest.temp.toFixed(1) : '—'} °C</td>
                        </tr>
                        {latest?.dist !== undefined && (
                          <tr>
                            <th>Ultrasonic Distance</th>
                            <td>{latest.dist.toFixed(1)} cm</td>
                          </tr>
                        )}
                        {latest?.vib !== undefined && (
                          <tr>
                            <th>Vibration (MPU6050)</th>
                            <td>{(latest.vib * 1000).toFixed(1)} mg RMS</td>
                          </tr>
                        )}
                        <tr>
                          <th>Mean Tracking Error (2 s)</th>
                          <td>{meanAbsError.toFixed(2)} RPM</td>
                        </tr>
                        {latest?.acl && (
                          <tr>
                            <th>AI Health Monitor</th>
                            <td style={{ fontWeight: 'bold', color: latest.acl === 'NORMAL' ? 'var(--color-success)' : latest.acl === 'LEARNING' ? 'var(--color-text-muted)' : 'var(--color-danger)' }}>
                              {latest.acl}
                              {latest.acl === 'LEARNING' ? ` (baseline ${Math.round((latest.abp ?? 0) * 100)} %)` : ` · score ${(latest.an ?? 0).toFixed(2)}`}
                            </td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>

                {/* Mathematical Plant Model */}
                <div className="panel">
                  <div className="panel-header">ESTIMATED PHYSICAL PLANT TRANSFER FUNCTION</div>
                  <div className="panel-body" style={{ display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'center', height: '100%' }}>
                    <div style={{ textAlign: 'center', padding: '10px' }}>
                      <span style={{ fontSize: '11px', color: 'var(--color-text-muted)', display: 'block', marginBottom: '8px' }}>Dynamic Speed Plant Model G(s):</span>
                      <div style={{ borderBottom: '1px solid black', padding: '2px 10px', fontSize: '13px', fontFamily: 'monospace', fontWeight: 'bold' }}>
                        {plantK.toFixed(3)} · e<sup>-{(plantDelay * 0.01).toFixed(2)}s</sup>
                      </div>
                      <div style={{ padding: '2px 10px', fontSize: '13px', fontFamily: 'monospace', fontWeight: 'bold' }}>
                        {plantTau.toFixed(3)}s + 1
                      </div>
                      <span style={{ fontSize: '10px', color: 'var(--color-success)', marginTop: '8px', display: 'block' }}>
                        {edgeId
                          ? (edgeId.idOk
                              ? `Identified on ESP32-S3 (online RLS, ${edgeId.idN} samples)`
                              : `ESP32-S3 learning… (${edgeId.idN} samples)`)
                          : 'Simulator plant (bench-identified N20)'}
                      </span>
                      <span style={{ fontSize: '10px', color: 'var(--color-text-muted)', marginTop: '4px', display: 'block' }}>
                        Phase margin {analysis.pm !== null ? `${analysis.pm.toFixed(0)}°` : 'n/a'} · closed-loop bandwidth {analysis.bw !== null ? `${analysis.bw.toFixed(1)} rad/s` : 'n/a'}
                      </span>
                    </div>
                  </div>
                </div>

                {/* Signal Generator Controls */}
                <div className="panel">
                  <div className="panel-header">LAB SIGNAL GENERATOR MODULE</div>
                  <div className="panel-body">
                    <div className="input-group">
                      <label>Excitation waveform</label>
                      <select 
                        className="input-industrial" 
                        value={excitationSignal} 
                        onChange={(e) => {
                          setExcitationSignal(e.target.value as any);
                          addLog(`SIGNAL: Configured excitation signal generator to [${e.target.value}].`);
                        }}
                      >
                        <option value="None">Static Constant Reference</option>
                        <option value="Step">Transient Step (Square)</option>
                        <option value="Sine Sweep">Variable Frequency Sine Sweep</option>
                        <option value="Impulse">Pulse Impulse Trigger</option>
                      </select>
                    </div>
                    <div className="input-group" style={{ marginTop: '8px' }}>
                      <label>Static Reference Speed (RPM)</label>
                      <input 
                        type="number" 
                        className="input-industrial" 
                        value={targetSpeed} 
                        onChange={(e) => setTargetSpeed(Math.max(0, Math.min(300, parseInt(e.target.value) || 0)))} 
                        min={0} 
                        max={300}
                      />
                    </div>
                    <div className="input-group" style={{ marginTop: '8px' }}>
                      <label>Controller Mode</label>
                      <select className="input-industrial" value={controllerMode} onChange={(e) => {
                        setControllerMode(e.target.value as any);
                        addLog(`STATE: Switched control loop mode to [${e.target.value}].`);
                      }}>
                        <option value="PID">Classical Parallel PID</option>
                        <option value="Manual">Manual PWM Feedforward</option>
                        <option value="Adaptive AI">Adaptive AI Self-Tuning</option>
                      </select>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* TAB CONTENT: DIGITAL TWIN 3D */}
            {activeTab === 'Digital Twin' && (
              <div className="panel">
                <div className="panel-header">3D MECHANICAL DIGITAL TWIN · JGA12-N20 BENCH RIG ({edgeId ? 'LIVE ESP32-S3 TELEMETRY' : isConnected ? 'BACKEND SIMULATOR' : 'LOCAL SIMULATOR'})</div>
                <div className="panel-body" style={{ padding: 8, backgroundColor: '#F8F9FA' }}>
                  <DigitalTwin latestRef={latestRef} latest={latest} telemetry={telemetry} live={!!edgeId} supplyV={supplyEstimate} />
                </div>
              </div>
            )}

            {/* TAB CONTENT: SYSTEM IDENTIFICATION (MATLAB Style) */}
            {activeTab === 'System ID' && (
              <div className="grid-2">
                <div className="panel">
                  <div className="panel-header">LEAST-SQUARES TF PARAMETER FITTING</div>
                  <div className="panel-body">
                    <p style={{ marginBottom: 10, color: 'var(--color-text-muted)' }}>
                      Batch fits run on the last 30 s of recorded data ({Math.min(recordRef.current.length, 3000)} samples buffered). Run an excitation step first for a clean fit.
                    </p>
                    <table className="table-dense">
                      <thead>
                        <tr>
                          <th>Model Type</th>
                          <th>Parameters Estimated</th>
                          <th>Free-run Fit</th>
                        </tr>
                      </thead>
                      <tbody>
                        {edgeId && (
                          <tr>
                            <td>1st order + delay (ESP32 online RLS)</td>
                            <td>K = {edgeId.idK!.toFixed(3)}, &tau; = {(edgeId.idTau! * 1000).toFixed(0)} ms, delay = {(edgeId.idD ?? 0) * 10} ms</td>
                            <td style={{ color: edgeId.idOk ? 'var(--color-success)' : 'var(--color-text-muted)', fontWeight: 'bold' }}>{edgeId.idOk ? 'converged (live)' : 'learning…'}</td>
                          </tr>
                        )}
                        {idResult?.first_order && (
                          <tr>
                            <td>1st order + delay (batch LS)</td>
                            <td>K = {idResult.first_order.K.toFixed(3)}, &tau; = {(idResult.first_order.tau * 1000).toFixed(0)} ms, delay = {idResult.first_order.delay * 10} ms</td>
                            <td style={{ color: 'var(--color-success)', fontWeight: 'bold' }}>{idResult.first_order.fit_pct.toFixed(1)} %</td>
                          </tr>
                        )}
                        {idResult?.second_order && (
                          <tr>
                            <td>2nd order + delay (batch LS)</td>
                            <td>K = {idResult.second_order.K.toFixed(3)}, &zeta; = {idResult.second_order.zeta.toFixed(2)}, &omega;<sub>n</sub> = {idResult.second_order.wn.toFixed(1)} rad/s</td>
                            <td>{idResult.second_order.fit_pct.toFixed(1)} %</td>
                          </tr>
                        )}
                        {idResult && idResult.status !== 'IDENTIFICATION_SUCCESS' && (
                          <tr><td colSpan={3} style={{ color: 'var(--color-danger)' }}>{idResult.message}</td></tr>
                        )}
                        {!edgeId && !idResult && (
                          <tr><td colSpan={3} style={{ color: 'var(--color-text-muted)' }}>No fit yet. Press Run Identification Engine.</td></tr>
                        )}
                      </tbody>
                    </table>
                    <div style={{ display: 'flex', gap: 8, marginTop: 15, flexWrap: 'wrap' }}>
                      <button className="btn-industrial primary" disabled={idBusy} onClick={runIdentification}>
                        {idBusy ? 'Fitting…' : 'Run Identification Engine'}
                      </button>
                      <button className="btn-industrial" onClick={triggerStepTest}>Run Excitation Step</button>
                      {edgeId && (
                        <button className="btn-industrial" onClick={() => sendCommand('idreset', 'AI MODULE: On-device model wiped; the ESP32 is relearning from live data.')}>
                          Relearn On-Device Model
                        </button>
                      )}
                    </div>
                  </div>
                </div>

                <div className="panel">
                  <div className="panel-header">POLE-ZERO MAP (s-plane)</div>
                  <div className="panel-body" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', backgroundColor: '#FFFFFF' }}>
                    {(() => {
                      const plantPole = -1 / plantTau;
                      const second = idResult?.second_order?.poles ?? [];
                      const all = [[plantPole, 0], ...second, ...analysis.poles];
                      // scale to the poles that shape the response; much faster ones are pinned off-scale
                      const fastLimit = 10 * Math.abs(plantPole);
                      const shown = all.filter(p => Math.abs(p[0]) <= fastLimit);
                      const span = Math.max(...shown.map(p => Math.max(Math.abs(p[0]), Math.abs(p[1])))) * 1.15 || 10;
                      const W = 300, H = 200, x0 = W - 30, y0 = H / 2;
                      const X = (re: number) => x0 + (Math.max(re, -span) / span) * (W - 50);
                      const Y = (im: number) => y0 - (im / span) * (H / 2 - 15);
                      const mark = (p: number[], color: string, key: string) => (
                        <text key={key} x={X(p[0])} y={Y(p[1]) + 4} fill={color} fontSize="14" fontWeight="bold" textAnchor="middle">×</text>
                      );
                      return (
                        <svg width={W} height={H} style={{ border: '1px solid #D9D9D9' }}>
                          <line x1={0} y1={y0} x2={W} y2={y0} stroke="#999" />
                          <line x1={x0} y1={0} x2={x0} y2={H} stroke="#999" />
                          <text x={8} y={y0 - 4} fontSize="9" fill="#666">{(-span).toFixed(0)}</text>
                          <text x={x0 + 4} y={12} fontSize="9" fill="#666">Im</text>
                          <text x={W - 22} y={y0 + 12} fontSize="9" fill="#666">Re</text>
                          {mark([plantPole, 0], '#D32F2F', 'plant')}
                          {second.map((p, i) => mark(p, '#F57C00', `s${i}`))}
                          {all.some(p => Math.abs(p[0]) > fastLimit) && <text x={22} y={y0 + 16} fontSize="9" fill="#F57C00">◀ off-scale fast pole</text>}
                          {analysis.poles.map((p, i) => mark(p, '#2E7D32', `c${i}`))}
                        </svg>
                      );
                    })()}
                    <div style={{ fontSize: 10, marginTop: 6, color: '#555' }}>
                      <span style={{ color: '#D32F2F' }}>× plant pole −1/&tau; = {(-1 / plantTau).toFixed(1)}</span>
                      {idResult?.second_order && <span style={{ color: '#F57C00' }}> · × 2nd-order fit</span>}
                      <span style={{ color: '#2E7D32' }}> · × closed loop (PI, no delay): {analysis.poles.map(p => p[1] ? `${p[0].toFixed(1)}±${Math.abs(p[1]).toFixed(1)}j` : p[0].toFixed(1)).filter((v, i, a) => a.indexOf(v) === i).join(', ')}</span>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* TAB CONTENT: CONTROLLER TUNING */}
            {activeTab === 'Controller' && (
              <div className="grid-2">
                <div className="panel">
                  <div className="panel-header">PID CONTROLLER GAINS INTERFACE</div>
                  <div className="panel-body">
                    <div className="input-group">
                      <label>Proportional Gain Kp ({kp})</label>
                      <input type="range" min="0.0" max="5.0" step="0.01" value={kp} onChange={(e) => setKp(parseFloat(e.target.value))} style={{ width: '100%' }} />
                    </div>
                    <div className="input-group" style={{ marginTop: '10px' }}>
                      <label>Integral Gain Ki ({ki})</label>
                      <input type="range" min="0.0" max="20.0" step="0.05" value={ki} onChange={(e) => setKi(parseFloat(e.target.value))} style={{ width: '100%' }} />
                    </div>
                    <div className="input-group" style={{ marginTop: '10px' }}>
                      <label>Derivative Gain Kd ({kd})</label>
                      <input type="range" min="0.0" max="0.5" step="0.01" value={kd} onChange={(e) => setKd(parseFloat(e.target.value))} style={{ width: '100%' }} />
                    </div>
                    <div className="input-group" style={{ marginTop: '10px' }}>
                      <label>Controller Mode</label>
                      <select className="input-industrial" value={controllerMode} onChange={(e) => {
                        setControllerMode(e.target.value as any);
                        addLog(`STATE: Switched control loop mode to [${e.target.value}].`);
                      }}>
                        <option value="PID">Classical Parallel PID</option>
                        <option value="Manual">Manual PWM Feedforward</option>
                        <option value="Adaptive AI">Adaptive AI Self-Tuning</option>
                      </select>
                    </div>
                    <div className="input-group" style={{ marginTop: '10px' }}>
                      <label>Adaptive AI Gain Source</label>
                      <select className="input-industrial" value={tunerSource} onChange={(e) => {
                        setTunerSource(e.target.value as 'nn' | 'lambda');
                        addLog(`AI MODULE: Adaptive AI gain source set to ${e.target.value === 'nn' ? 'the neural tuner' : 'the lambda rule'}.`);
                      }}>
                        <option value="nn">Neural tuner (trained network, on ESP32)</option>
                        <option value="lambda">Lambda rule (analytic IMC)</option>
                      </select>
                    </div>
                  </div>
                </div>

                <div className="panel">
                  <div className="panel-header">CONTROLLER MATH EQUATION</div>
                  <div className="panel-body" style={{ display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'center', gap: 10, height: '100%' }}>
                    <div style={{ padding: '15px', backgroundColor: '#F8F9FA', border: '1px solid var(--color-border)', width: '90%' }}>
                      <div style={{ fontSize: 10, color: 'var(--color-text-muted)', textAlign: 'center', marginBottom: 4 }}>Dashboard (PID mode) gains</div>
                      <code style={{ fontSize: '12px', display: 'block', textAlign: 'center', color: 'var(--color-accent)' }}>
                        U(t) = {kp}·e(t) + {ki}·∫e(t)dt − {kd}·dy(t)/dt
                      </code>
                    </div>
                    {appliedFromEsp && (
                      <div style={{ padding: '15px', backgroundColor: '#F1F8E9', border: '1px solid var(--color-border)', width: '90%' }}>
                        <div style={{ fontSize: 10, color: 'var(--color-text-muted)', textAlign: 'center', marginBottom: 4 }}>Applied on the ESP32 right now ({latest?.mode})</div>
                        <code style={{ fontSize: '12px', display: 'block', textAlign: 'center', color: 'var(--color-success)' }}>
                          U(t) = {gainsInUse.kp.toFixed(3)}·e(t) + {gainsInUse.ki.toFixed(3)}·∫e(t)dt − {gainsInUse.kd.toFixed(3)}·dy(t)/dt
                        </code>
                      </div>
                    )}
                    <div style={{ fontSize: 10, color: 'var(--color-text-muted)' }}>
                      D acts on the measured speed (no derivative kick); the integrator is clamped while the PWM saturates.
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* TAB CONTENT: AI PREDICTOR WORKSPACE */}
            {activeTab === 'AI Workspace' && (
              <div className="grid-2">
                <div className="panel">
                  <div className="panel-header">AI AGENT MODEL PREDICTION (Self-Optimizing Setup)</div>
                  <div className="panel-body">
                    {edgeId ? (
                    <>
                    <p style={{ marginBottom: 12, color: 'var(--color-text-muted)' }}>Running on the ESP32-S3 at 100 Hz, learned from live motor data:</p>
                    <table className="table-dense">
                      <tbody>
                        <tr>
                          <th>On-device Estimator</th>
                          <td>Recursive least squares bank (delays 10–60 ms), best model kept</td>
                        </tr>
                        <tr>
                          <th>Identified Plant</th>
                          <td>K = {edgeId.idK!.toFixed(3)} RPM/PWM, &tau; = {(edgeId.idTau! * 1000).toFixed(0)} ms, delay = {(edgeId.idD ?? 0) * 10} ms</td>
                        </tr>
                        <tr>
                          <th>Neural Tuner Gains (on-device MLP)</th>
                          <td style={{ color: 'var(--color-success)', fontWeight: 'bold' }}>
                            {edgeId.idOk ? `Kp ${edgeId.nKp!.toFixed(3)} · Ki ${edgeId.nKi!.toFixed(3)} · Kd 0` : 'waiting for the model to converge'}
                          </td>
                        </tr>
                        <tr>
                          <th>Lambda Rule Gains (analytic)</th>
                          <td>{edgeId.idOk ? `Kp ${edgeId.aKp!.toFixed(3)} · Ki ${edgeId.aKi!.toFixed(3)} · Kd 0` : '—'}</td>
                        </tr>
                        <tr>
                          <th>Adaptive AI Uses</th>
                          <td>{edgeId.tun === 'lambda' ? 'Lambda rule' : 'Neural tuner'}{latest?.mode === 'Adaptive AI' ? ' (active now)' : ' (switch mode to Adaptive AI)'}</td>
                        </tr>
                        <tr>
                          <th>Model Status</th>
                          <td>{edgeId.idOk ? 'Converged' : 'Learning'} ({edgeId.idN} informative samples)</td>
                        </tr>
                      </tbody>
                    </table>
                    <div style={{ marginTop: '15px', display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                      <button className="btn-industrial primary" onClick={() => {
                        setTunerSource('nn'); setControllerMode('Adaptive AI');
                        addLog("AI MODULE: Adaptive AI with the neural tuner: the ESP32 applies its own gains continuously.");
                      }}>
                        Run Adaptive AI (Neural)
                      </button>
                      <button className="btn-industrial" disabled={!edgeId.idOk} onClick={() => {
                        setKp(Number(edgeId.nKp!.toFixed(2))); setKi(Number(edgeId.nKi!.toFixed(2))); setKd(0);
                        addLog(`AI MODULE: Deployed neural-tuner gains (Kp=${edgeId.nKp!.toFixed(2)}, Ki=${edgeId.nKi!.toFixed(2)}, Kd=0) to the PID sliders.`);
                      }}>
                        Deploy Neural Gains to PID
                      </button>
                      <button className="btn-industrial" disabled={!edgeId.idOk} onClick={() => {
                        setKp(Number(edgeId.aKp!.toFixed(2))); setKi(Number(edgeId.aKi!.toFixed(2))); setKd(0);
                        addLog(`AI MODULE: Deployed lambda-rule gains (Kp=${edgeId.aKp!.toFixed(2)}, Ki=${edgeId.aKi!.toFixed(2)}, Kd=0) to the PID sliders.`);
                      }}>
                        Deploy Lambda Gains to PID
                      </button>
                      <button className="btn-industrial" onClick={() => sendCommand('idreset', 'AI MODULE: On-device model wiped; the ESP32 is relearning from live data.')}>
                        Relearn On-Device Model
                      </button>
                    </div>
                    </>
                    ) : (
                    <>
                    <p style={{ marginBottom: 12, color: 'var(--color-text-muted)' }}>Simulator mode: the backend runs the same trained network for the simulated plant.</p>
                    <table className="table-dense">
                      <tbody>
                        <tr><th>Plant (simulator)</th><td>K = 1.2, &tau; = 60 ms, delay 30 ms (bench-identified N20)</td></tr>
                        <tr><th>Neural Tuner Gains</th><td style={{ color: 'var(--color-success)', fontWeight: 'bold' }}>
                          {simTune ? `Kp ${simTune.neural.kp.toFixed(3)} · Ki ${simTune.neural.ki.toFixed(3)} · Kd 0` : 'backend offline'}
                        </td></tr>
                        <tr><th>Lambda Rule Gains</th><td>{simTune ? `Kp ${simTune.lambda.kp.toFixed(3)} · Ki ${simTune.lambda.ki.toFixed(3)} · Kd 0` : '—'}</td></tr>
                      </tbody>
                    </table>
                    <div style={{ marginTop: '15px', display: 'flex', gap: '8px' }}>
                      <button className="btn-industrial primary" disabled={!simTune} onClick={() => {
                        if (!simTune) return;
                        setKp(Number(simTune.neural.kp.toFixed(2))); setKi(Number(simTune.neural.ki.toFixed(2))); setKd(0);
                        addLog(`AI MODULE: Deployed neural-tuner gains (Kp=${simTune.neural.kp.toFixed(2)}, Ki=${simTune.neural.ki.toFixed(2)}) to the PID sliders.`);
                      }}>
                        Deploy Neural Gains
                      </button>
                    </div>
                    </>
                    )}
                  </div>
                </div>

                <div className="panel">
                  <div className="panel-header">NEURAL TUNER MODEL CARD</div>
                  <div className="panel-body" style={{ padding: '10px' }}>
                    {nnReport ? (
                      <>
                        <table className="table-dense" style={{ marginBottom: 10 }}>
                          <tbody>
                            <tr><th>Architecture</th><td>{nnReport.architecture}</td></tr>
                            <tr><th>Training Data</th><td>{nnReport.n_plants} simulated motors ({nnReport.n_train} train / {nnReport.n_val} held out), labels = closed-loop-optimal PI gains</td></tr>
                            <tr><th>Held-out Cost vs Optimum</th><td>NN {nnReport.cost_ratio_vs_optimum.nn_median}× median ({nnReport.cost_ratio_vs_optimum.nn_p90}× p90) · lambda {nnReport.cost_ratio_vs_optimum.lambda_median}× ({nnReport.cost_ratio_vs_optimum.lambda_p90}×)</td></tr>
                            <tr><th>Beats Lambda Rule</th><td>{nnReport.nn_better_than_lambda_pct} % of held-out motors</td></tr>
                            <tr><th>Trained</th><td>{new Date(nnReport.trained_at).toLocaleString()}</td></tr>
                          </tbody>
                        </table>
                        <div style={{ fontSize: 10, fontWeight: 'bold', marginBottom: 6 }}>PERMUTATION FEATURE IMPORTANCE</div>
                        {Object.entries(nnReport.feature_importance).map(([name, v]) => (
                          <div key={name} style={{ marginBottom: '8px' }}>
                            <span style={{ fontSize: '10px', color: '#555555' }}>{name.toUpperCase()} ({(v * 100).toFixed(1)}%)</span>
                            <div style={{ width: '100%', height: '12px', backgroundColor: '#EAEAEA' }}>
                              <div style={{ width: `${v * 100}%`, height: '100%', backgroundColor: 'var(--color-accent)' }}></div>
                            </div>
                          </div>
                        ))}
                      </>
                    ) : <span style={{ color: 'var(--color-text-muted)' }}>Model card unavailable (backend offline).</span>}
                  </div>
                </div>
              </div>
            )}

            {/* TAB CONTENT: FAULT DETECT PANEL */}
            {activeTab === 'Faults' && (() => {
              const bar = (v: number, color: string) => (
                      <div style={{ width: '100%', height: '10px', backgroundColor: '#EAEAEA' }}>
                        <div style={{ width: `${Math.round(Math.max(0, Math.min(1, v)) * 100)}%`, height: '100%', backgroundColor: color }}></div>
                      </div>
                    );
              const cur = latest?.current ?? 0, temp = latest?.temp ?? 0;
              const st = (ok: boolean, warn: boolean, label?: string) => (
                <td style={{ fontWeight: 'bold', color: ok ? 'var(--color-success)' : warn ? 'var(--color-warning)' : 'var(--color-danger)' }}>
                  {label ?? (ok ? 'NORMAL' : warn ? 'WARNING' : 'TRIPPED')}
                </td>
              );
              return (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 15 }}>
                <div className="grid-2">
                  <div className="panel">
                    <div className="panel-header">PROTECTION LIMITS (FIRMWARE, HARD CUT-OFF)</div>
                    <div className="panel-body">
                      <table className="table-dense" style={{ marginBottom: 10 }}>
                        <thead><tr><th>Condition</th><th>Status</th><th>Live Metric</th><th>Limit / Action</th></tr></thead>
                        <tbody>
                          <tr>
                            <td>Overcurrent (INA219)</td>
                            {st(fault !== 'OVERCURRENT' && cur < 1.0, fault !== 'OVERCURRENT')}
                            <td>{cur.toFixed(3)} A</td>
                            <td>{fault === 'OVERCURRENT' ? 'Motor cut, latched' : '>1.2 A for 200 ms or >2.0 A'}</td>
                          </tr>
                          <tr>
                            <td>Motor Stall</td>
                            {st(fault !== 'STALL', false)}
                            <td>{latest ? `${latest.input.toFixed(0)} PWM @ ${latest.output.toFixed(0)} RPM` : '—'}</td>
                            <td>{fault === 'STALL' ? 'Motor cut, latched' : '>150 PWM, <15 RPM for 0.5 s'}</td>
                          </tr>
                          <tr>
                            <td>Winding Over-temperature</td>
                            {st(fault !== 'OVERHEAT' && temp < 45, fault !== 'OVERHEAT')}
                            <td>{temp.toFixed(1)} °C</td>
                            <td>{fault === 'OVERHEAT' ? 'Motor cut, latched' : '58 °C'}</td>
                          </tr>
                          <tr>
                            <td>Host Link Watchdog</td>
                            {st(isConnected, false, isConnected ? 'LINKED' : 'OFFLINE')}
                            <td>{isConnected && latency !== null ? `${latency.toFixed(1)} ms RTT` : '—'}</td>
                            <td>Motor stops after 1.5 s of silence</td>
                          </tr>
                          <tr>
                            <td>Emergency Stop</td>
                            {st(!isEStop && fault !== 'ESTOP', false, isEStop || fault === 'ESTOP' ? 'ACTIVE' : 'RELEASED')}
                            <td>{fault}</td>
                            <td>Releasing clears latched faults</td>
                          </tr>
                        </tbody>
                      </table>
                      {isEStop ? (
                        <button className="btn-industrial success" style={{ width: '100%' }} onClick={() => {
                          setIsEStop(false);
                          addLog("SAFETY: Manual Emergency Stop reset. Resuming plant operations.");
                        }}>
                          RESET EMERGENCY STOP (ARM SYSTEM)
                        </button>
                      ) : (
                        <button className="btn-industrial danger" style={{ width: '100%' }} onClick={() => {
                          setIsEStop(true);
                          addLog("SAFETY: Manual Emergency Stop triggered. Motor output disabled.");
                        }}>
                          EMERGENCY SHUTDOWN (E-STOP)
                        </button>
                      )}
                    </div>
                  </div>

                  <div className="panel">
                    <div className="panel-header">AI ANOMALY DETECTION (ON-DEVICE, LEARNED BASELINE)</div>
                    <div className="panel-body">
                      {latest?.acl ? (
                        <>
                          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
                            <span style={{ fontWeight: 'bold', fontSize: 13, color: latest.acl === 'NORMAL' ? 'var(--color-success)' : latest.acl === 'LEARNING' ? 'var(--color-text-muted)' : 'var(--color-danger)' }}>
                              {latest.acl}
                            </span>
                            <span style={{ fontSize: 11 }}>
                              {latest.acl === 'LEARNING' ? `learning healthy baseline: ${Math.round((latest.abp ?? 0) * 100)} %` : `anomaly score ${(latest.an ?? 0).toFixed(2)}`}
                            </span>
                          </div>
                          {bar(latest.acl === 'LEARNING' ? (latest.abp ?? 0) : (latest.an ?? 0), latest.acl === 'LEARNING' ? '#9E9E9E' : (latest.an ?? 0) > 0.3 ? '#D32F2F' : '#2E7D32')}
                          <table className="table-dense" style={{ marginTop: 10 }}>
                            <thead><tr><th>Indicator</th><th>Value</th><th style={{ width: '40%' }}>vs. baseline</th></tr></thead>
                            <tbody>
                              <tr><td>Speed vs digital twin</td><td>{(latest.zs ?? 0).toFixed(1)} σ</td><td>{bar(Math.abs(latest.zs ?? 0) / 8, Math.abs(latest.zs ?? 0) > 4 ? '#D32F2F' : '#1976D2')}</td></tr>
                              <tr><td>Current vs expected</td><td>{(latest.zi ?? 0).toFixed(1)} σ</td><td>{bar(Math.abs(latest.zi ?? 0) / 8, Math.abs(latest.zi ?? 0) > 4 ? '#D32F2F' : '#1976D2')}</td></tr>
                              <tr><td>Vibration vs expected</td><td>{(latest.zv ?? 0).toFixed(1)} σ</td><td>{bar(Math.abs(latest.zv ?? 0) / 8, Math.abs(latest.zv ?? 0) > 4 ? '#D32F2F' : '#1976D2')}</td></tr>
                              <tr><td>Motor gain drift</td><td>{(latest.kdr ?? 0).toFixed(1)} %</td><td>{bar(Math.abs(latest.kdr ?? 0) / 40, Math.abs(latest.kdr ?? 0) > 10 ? '#F57C00' : '#1976D2')}</td></tr>
                              <tr><td>Thermal margin used</td><td>{Math.round((latest.therm ?? 0) * 100)} %</td><td>{bar(latest.therm ?? 0, (latest.therm ?? 0) > 0.6 ? '#F57C00' : '#1976D2')}</td></tr>
                            </tbody>
                          </table>
                          <button className="btn-industrial" style={{ marginTop: 10 }} onClick={() => sendCommand('baseline', 'AI MODULE: Relearning the healthy baseline (run the motor normally for ~6 s).')}>
                            Relearn Healthy Baseline
                          </button>
                          <p style={{ fontSize: 10, color: 'var(--color-text-muted)', marginTop: 8 }}>
                            The ESP32 learns how this motor normally behaves, then scores deviations: a digital twin of the learned model runs on the same PWM, and the current and vibration are compared with what is normal at this speed. Advisory only; the hard limits on the left still cut the motor.
                          </p>
                        </>
                      ) : <span style={{ color: 'var(--color-text-muted)' }}>Anomaly detection runs on the ESP32 (connect the hardware).</span>}
                    </div>
                  </div>
                </div>

                <div className="panel">
                  <div className="panel-header">ALARM TIMELINE</div>
                  <div className="panel-body">
                    <table className="table-dense">
                      <thead><tr><th style={{ width: 80 }}>Time</th><th style={{ width: 160 }}>Event</th><th>Detail</th></tr></thead>
                      <tbody>
                        {alarms.length ? alarms.map((a, i) => (
                          <tr key={i}><td>{a.t}</td><td style={{ fontWeight: 'bold', color: a.kind === 'NOMINAL' || a.kind === 'ANOMALY NORMAL' ? 'var(--color-success)' : a.kind.startsWith('ANOMALY') || a.kind === 'IDLE' ? 'var(--color-warning)' : 'var(--color-danger)' }}>{a.kind}</td><td>{a.detail}</td></tr>
                        )) : <tr><td colSpan={3} style={{ color: 'var(--color-text-muted)' }}>No events yet.</td></tr>}
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>
              );
            })()}

            {/* TAB CONTENT: SETTINGS */}
            {activeTab === 'Settings' && (() => {
              const info = hw?.info ?? {};
              const field = (label: string, value: string) => (
                <div className="input-group">
                  <label>{label}</label>
                  <input type="text" className="input-industrial" value={value} readOnly />
                </div>
              );
              return (
              <div className="panel">
                <div className="panel-header">LAB CONFIGURATION PARAMETERS ({hw?.mode === 'hardware' ? 'READ FROM THE ESP32 FIRMWARE' : 'SIMULATOR'})</div>
                <div className="panel-body">
                  <div className="grid-2">
                    {field('ESP32 Link', hw?.mode === 'hardware' ? `${hw.port} @ ${hw.baud} baud (${hw.connected ? 'streaming' : 'silent'})` : 'not configured (simulator)')}
                    {field('Firmware Build', info.fw ?? '—')}
                    {field('Encoder PPR (per channel, motor shaft)', info.encoder_ppr !== undefined ? String(info.encoder_ppr) : '—')}
                    {field('Gearbox Ratio / Counts per Output Rev', info.gear_ratio !== undefined ? `1:${info.gear_ratio} / ${info.counts_per_rev}` : '—')}
                    {field('Target Motor Power (V)', info.supply_nominal_v !== undefined ? `${info.supply_nominal_v} V nominal${supplyEstimate ? `, ~${supplyEstimate.toFixed(1)} V estimated from the learned gain` : ''}` : '—')}
                    {field('Controller Time Delta dt (seconds)', info.control_hz ? `${(1 / info.control_hz).toFixed(3)} (${info.control_hz} Hz)` : '0.010')}
                    {field('PWM Frequency', info.pwm_hz ? `${info.pwm_hz / 1000} kHz` : '—')}
                    {field('Current Limits', info.current_trip_a !== undefined ? `${info.current_sustain_a} A sustained / ${info.current_trip_a} A instant` : '—')}
                    {field('Overheat Limit', info.overheat_c !== undefined ? `${info.overheat_c} °C` : '—')}
                    {field('Host-link Watchdog', info.host_timeout_ms !== undefined ? `${info.host_timeout_ms} ms` : '—')}
                    {field('On-device Neural Tuner', info.nn ?? '—')}
                    {field('Firmware Uptime', info.uptime_s !== undefined ? `${info.uptime_s} s (last reset: ${info.reset})` : '—')}
                  </div>
                  {hw?.status_lines && hw.status_lines.length > 0 && (
                    <pre style={{ marginTop: 12, fontSize: 10, background: '#111', color: '#9f9', padding: 8, whiteSpace: 'pre-wrap' }}>
                      {hw.status_lines.filter(l => !/source=|DS18B20|hcsr04/i.test(l)).join('\n')}
                    </pre>
                  )}
                </div>
              </div>
              );
            })()}

            {/* TAB CONTENT: FREQUENCY RESPONSE (BODE PLOT) */}
            {activeTab === 'Frequency' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 15 }}>
                <div className="panel">
                  <div className="panel-header">DYNAMIC BODE RESPONSE PLOT (MAGNITUDE & PHASE) · {edgeId?.idOk ? 'LEARNED ON THE ESP32' : 'NOMINAL MODEL'}</div>
                  <div className="panel-body" style={{ padding: 10 }}>
                    <canvas ref={bodeCanvasRef} width={1000} height={340} style={{ border: '1px solid var(--color-border)', width: '100%', height: '340px' }}></canvas>
                  </div>
                </div>
                
                <div className="panel">
                  <div className="panel-header">FREQUENCY DESIGN SPECIFICATIONS (gains: Kp {anaKp.toFixed(2)}, Ki {anaKi.toFixed(2)})</div>
                  <div className="panel-body">
                    <table className="table-dense">
                      <thead>
                        <tr><th>Parameter</th><th>Value</th><th>Status</th></tr>
                      </thead>
                      <tbody>
                        <tr>
                          <td>Plant Bandwidth (1/&tau;)</td>
                          <td style={{ fontFamily: 'monospace' }}>{(1 / plantTau).toFixed(2)} rad/s</td>
                          <td>Open-loop motor corner</td>
                        </tr>
                        <tr>
                          <td>Gain Crossover &omega;<sub>c</sub></td>
                          <td style={{ fontFamily: 'monospace' }}>{analysis.wc !== null ? `${analysis.wc.toFixed(1)} rad/s` : 'n/a'}</td>
                          <td>|C·G| = 0 dB</td>
                        </tr>
                        <tr>
                          <td>Phase Margin (PM)</td>
                          <td style={{ fontFamily: 'monospace' }}>{analysis.pm !== null ? `${analysis.pm.toFixed(1)}°` : 'n/a'}</td>
                          <td style={{ fontWeight: 'bold', color: analysis.pm === null ? 'inherit' : analysis.pm >= 45 ? 'var(--color-success)' : analysis.pm >= 30 ? 'var(--color-warning)' : 'var(--color-danger)' }}>
                            {analysis.pm === null ? '—' : analysis.pm >= 45 ? 'ROBUST' : analysis.pm >= 30 ? 'MARGINAL' : 'POOR'}
                          </td>
                        </tr>
                        <tr>
                          <td>Gain Margin (GM)</td>
                          <td style={{ fontFamily: 'monospace' }}>{analysis.gm !== null ? `${analysis.gm.toFixed(1)} dB @ ${analysis.w180!.toFixed(0)} rad/s` : '∞ dB'}</td>
                          <td style={{ fontWeight: 'bold', color: analysis.gm === null || analysis.gm >= 6 ? 'var(--color-success)' : 'var(--color-danger)' }}>
                            {analysis.gm === null || analysis.gm >= 6 ? 'STABLE' : 'LOW'}
                          </td>
                        </tr>
                        <tr>
                          <td>Closed-loop Bandwidth (−3 dB)</td>
                          <td style={{ fontFamily: 'monospace' }}>{analysis.bw !== null ? `${analysis.bw.toFixed(1)} rad/s (${(analysis.bw / (2 * Math.PI)).toFixed(2)} Hz)` : 'n/a'}</td>
                          <td>Tracking speed</td>
                        </tr>
                        <tr>
                          <td>Steady-State Plant Gain K</td>
                          <td style={{ fontFamily: 'monospace' }}>{plantK.toFixed(3)} RPM/PWM</td>
                          <td>Integral action: zero steady-state error</td>
                        </tr>
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>
            )}

            {/* TAB CONTENT: STATE SPACE REPRESENTATION */}
            {activeTab === 'State Space' && (() => {
              const M = (v: string) => (
                <div style={{ display: 'inline-block', borderLeft: '2px solid black', borderRight: '2px solid black', padding: '5px 15px', fontFamily: 'monospace', fontSize: 13 }}>{v}</div>
              );
              const A = -1 / plantTau, B = plantK / plantTau;
              const a11 = -(1 + plantK * anaKp) / plantTau, a12 = plantK * anaKi / plantTau;
              const fmtPole = (p: number[]) => p[1] ? `${p[0].toFixed(2)} ± ${Math.abs(p[1]).toFixed(2)}j` : p[0].toFixed(2);
              const uniq = analysis.poles.map(fmtPole).filter((v, i, a) => a.indexOf(v) === i);
              return (
              <div className="grid-2">
                <div className="panel">
                  <div className="panel-header">STATE-SPACE EQUATION MATRICES (x = speed, u = PWM) · {edgeId?.idOk ? 'LEARNED' : 'NOMINAL'}</div>
                  <div className="panel-body">
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                      <div><label style={{ fontWeight: 'bold', display: 'block', marginBottom: 5 }}>A Matrix (Dynamics Matrix)</label>{M(`[ ${A.toFixed(3)} ]`)}<span style={{ marginLeft: 10, fontSize: 10, color: 'var(--color-text-muted)' }}>(1x1, −1/&tau;)</span></div>
                      <div><label style={{ fontWeight: 'bold', display: 'block', marginBottom: 5 }}>B Matrix (Input Matrix)</label>{M(`[ ${B.toFixed(3)} ]`)}<span style={{ marginLeft: 10, fontSize: 10, color: 'var(--color-text-muted)' }}>(1x1, K/&tau;)</span></div>
                      <div><label style={{ fontWeight: 'bold', display: 'block', marginBottom: 5 }}>C Matrix (Output Matrix)</label>{M('[ 1.0 ]')}</div>
                      <div><label style={{ fontWeight: 'bold', display: 'block', marginBottom: 5 }}>D Matrix (Feedforward Matrix)</label>{M('[ 0.0 ]')}</div>
                      <div><label style={{ fontWeight: 'bold', display: 'block', marginBottom: 5 }}>Closed loop with PI, state [x, ∫e]</label>
                        {M(`[ ${a11.toFixed(2)}  ${a12.toFixed(2)} ;  -1  0 ]`)}
                        <span style={{ marginLeft: 10, fontSize: 10, color: 'var(--color-text-muted)' }}>(delay of {plantDelay * 10} ms not included)</span>
                      </div>
                    </div>
                  </div>
                </div>

                <div className="panel">
                  <div className="panel-header">CONTROLLABILITY & OBSERVABILITY TEST</div>
                  <div className="panel-body">
                    <table className="table-dense">
                      <tbody>
                        <tr><td>Open-loop Eigenvalue</td><td style={{ fontFamily: 'monospace', fontWeight: 'bold' }}>&lambda; = {A.toFixed(3)}</td></tr>
                        <tr><td>Controllability Matrix Q_c = [B]</td><td style={{ fontFamily: 'monospace' }}>[ {B.toFixed(3)} ]</td></tr>
                        <tr><td>Observability Matrix Q_o = [C]</td><td style={{ fontFamily: 'monospace' }}>[ 1.0 ]</td></tr>
                        <tr><td>System Controllability</td><td style={{ color: 'var(--color-success)', fontWeight: 'bold' }}>{B !== 0 ? 'YES (Full Rank)' : 'NO'}</td></tr>
                        <tr><td>System Observability</td><td style={{ color: 'var(--color-success)', fontWeight: 'bold' }}>YES (Full Rank)</td></tr>
                        <tr><td>State Transition Matrix &Phi;(t)</td><td style={{ fontFamily: 'monospace' }}>[ e^({A.toFixed(3)}·t) ]</td></tr>
                        <tr><td>Closed-loop Poles (Kp {anaKp.toFixed(2)}, Ki {anaKi.toFixed(2)})</td><td style={{ fontFamily: 'monospace', fontWeight: 'bold' }}>{uniq.join(', ')}</td></tr>
                        <tr><td>Closed-loop &omega;<sub>n</sub> / &zeta;</td><td style={{ fontFamily: 'monospace' }}>{analysis.wn.toFixed(1)} rad/s / {analysis.zeta.toFixed(2)}</td></tr>
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>
              );
            })()}

            {/* TAB CONTENT: EXPORT REPORTS */}
            {activeTab === 'Reports' && (() => {
              const m = stepMetrics(recordRef.current.slice(-2000));
              return (
              <div className="panel">
                <div className="panel-header">EXPORT LABORATORY REPORTS AND HISTORIC LOGGER FILES</div>
                <div className="panel-body">
                  <p style={{ marginBottom: 15, color: 'var(--color-text-muted)' }}>
                    Reports use the live model, the gains in use and the recorded data ({(recordRef.current.length / 100).toFixed(1)} s buffered, up to {RECORD_SECONDS} s).
                  </p>
                  <div className="grid-2" style={{ marginBottom: 15 }}>
                    <div className="input-group">
                      <label>Operator/Engineer Name</label>
                      <input type="text" className="input-industrial" value={operator} onChange={e => setOperator(e.target.value)} />
                    </div>
                    <div className="input-group">
                      <label>Report Header Template</label>
                      <input type="text" className="input-industrial" value={reportTitle} onChange={e => setReportTitle(e.target.value)} />
                    </div>
                  </div>
                  <table className="table-dense" style={{ marginBottom: 12 }}>
                    <tbody>
                      <tr><th>Last step in buffer</th><td>{m ? `${m.from_rpm} → ${m.to_rpm} RPM` : 'none (change the setpoint or run an excitation step)'}</td></tr>
                      {m && <tr><th>Rise / settling (2 %) / overshoot</th><td>{m.rise_time_s ?? 'n/a'} s / {m.settling_time_s ?? 'n/a'} s / {m.overshoot_pct} %</td></tr>}
                      {m && <tr><th>IAE / steady-state error</th><td>{m.iae} / {m.steady_state_error_rpm} RPM</td></tr>}
                    </tbody>
                  </table>
                  <div style={{ display: 'flex', gap: 10, marginTop: 15, flexWrap: 'wrap' }}>
                    <button className="btn-industrial primary" onClick={printReport}>Generate PDF Report</button>
                    <button className="btn-industrial" onClick={exportCsv}>Export CSV Logs</button>
                    <button className="btn-industrial" onClick={exportLatex}>Generate LaTeX Template</button>
                    <button className="btn-industrial" onClick={saveRun}>Save Run to SQLite</button>
                  </div>
                </div>
              </div>
              );
            })()}

            {/* TAB CONTENT: SAVED RUNS (SQLITE) */}
            {activeTab === 'Runs' && (
              <div className="grid-2">
                <div className="panel">
                  <div className="panel-header">SAVED RUNS (SQLITE)</div>
                  <div className="panel-body">
                    <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
                      <button className="btn-industrial primary" onClick={saveRun}>Save Current Run</button>
                      <button className="btn-industrial" onClick={refreshRuns}><RefreshCw size={11} /> Refresh</button>
                    </div>
                    <table className="table-dense">
                      <thead><tr><th>#</th><th>Saved</th><th>Title</th><th>Controller</th><th>Settle</th><th>Overshoot</th><th></th></tr></thead>
                      <tbody>
                        {runs.length ? runs.map(r => (
                          <tr key={r.id} style={{ background: selectedRun?.id === r.id ? '#E3F2FD' : undefined }}>
                            <td>{r.id}</td>
                            <td>{r.created.replace('T', ' ')}</td>
                            <td>{r.title}</td>
                            <td>{r.controller} ({r.kp.toFixed(2)}/{r.ki.toFixed(2)}/{r.kd.toFixed(2)})</td>
                            <td>{r.metrics.settling_time_s ?? '—'} s</td>
                            <td>{r.metrics.overshoot_pct ?? '—'} %</td>
                            <td style={{ whiteSpace: 'nowrap' }}>
                              <button className="btn-industrial" onClick={() => loadRun(r.id)}>Load</button>{' '}
                              <button className="btn-industrial danger" onClick={() => deleteRun(r.id)}>Delete</button>
                            </td>
                          </tr>
                        )) : <tr><td colSpan={7} style={{ color: 'var(--color-text-muted)' }}>No saved runs yet.</td></tr>}
                      </tbody>
                    </table>
                  </div>
                </div>
                <div className="panel">
                  <div className="panel-header">RUN DETAILS {selectedRun ? `#${selectedRun.id}` : ''}</div>
                  <div className="panel-body">
                    {selectedRun ? (
                      <>
                        <canvas ref={runCanvasRef} width={700} height={220} style={{ width: '100%', border: '1px solid var(--color-border)' }}></canvas>
                        <table className="table-dense" style={{ marginTop: 10 }}>
                          <tbody>
                            <tr><th>Operator / source</th><td>{selectedRun.operator} · {selectedRun.source}</td></tr>
                            <tr><th>Model</th><td>K = {Number(selectedRun.model.K).toFixed(3)}, &tau; = {(Number(selectedRun.model.tau) * 1000).toFixed(0)} ms, delay = {Number(selectedRun.model.delay) * 10} ms ({selectedRun.model.identified_on})</td></tr>
                            {Object.entries(selectedRun.metrics).map(([k, v]) => <tr key={k}><th>{k.replace(/_/g, ' ')}</th><td>{String(v ?? 'n/a')}</td></tr>)}
                          </tbody>
                        </table>
                      </>
                    ) : <span style={{ color: 'var(--color-text-muted)' }}>Load a run to see its recording and metrics.</span>}
                  </div>
                </div>
              </div>
            )}

          </div>

          {/* 3. BOTTOM TERMINAL LOGS CONSOLE */}
          <footer className="app-console">
            <div className="console-header">
              <span>SYSTEM EVENT DIALOG LOGS</span>
              <button 
                style={{ background: 'none', border: 'none', color: 'var(--color-text-light)', cursor: 'pointer', fontSize: 10 }}
                onClick={() => setLogs([])}
              >
                Clear Log Frame
              </button>
            </div>
            <div className="console-output">
              {logs.map((log, index) => (
                <div key={index}>{log}</div>
              ))}
              <div ref={logsEndRef} />
            </div>
          </footer>

        </main>

        {/* 4. RIGHT SIDE INSPECTOR PANEL */}
        <aside className="app-inspector">
          <div className="inspector-header">
            <span>PARAMETER INSPECTOR</span>
            <Chip size={12} />
          </div>
          
          <div className="inspector-section">
            <div className="inspector-title">Active Controller Gains</div>
            {(() => { const g = appliedFromEsp ? gainsInUse : { kp, ki, kd }; return (<>
            <div className="input-group">
              <label>Proportional Gain (Kp)</label>
              <input type="text" className="input-industrial" value={g.kp.toFixed(3)} readOnly />
            </div>
            <div className="input-group" style={{ marginTop: 5 }}>
              <label>Integral Gain (Ki)</label>
              <input type="text" className="input-industrial" value={g.ki.toFixed(3)} readOnly />
            </div>
            <div className="input-group" style={{ marginTop: 5 }}>
              <label>Derivative Gain (Kd)</label>
              <input type="text" className="input-industrial" value={g.kd.toFixed(3)} readOnly />
            </div>
            <div style={{ fontSize: 10, color: 'var(--color-text-muted)', marginTop: 4 }}>
              {appliedFromEsp ? `Applied on the ${hw?.mode === 'hardware' ? 'ESP32' : 'simulator'} (${latest?.mode})` : 'Dashboard setting'}
            </div>
            </>); })()}
          </div>

          <div className="inspector-section">
            <div className="inspector-title">Power Configuration</div>
            <div className="input-group">
              <label>Motor Supply (estimated from learned gain)</label>
              <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                <span className="status-indicator">
                  <span className={`status-dot ${supplyEstimate === null ? 'grey' : supplyEstimate > 10.5 ? 'green' : 'yellow'}`}></span>
                </span>
                <span style={{ fontFamily: 'monospace', fontWeight: 'bold' }}>{supplyEstimate !== null ? `${supplyEstimate.toFixed(1)} V DC` : '— (learning)'}</span>
              </div>
            </div>
            <div className="input-group" style={{ marginTop: 8 }}>
              <label>ESP32 Link</label>
              <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                <span className="status-indicator">
                  <span className={`status-dot ${isConnected && hw?.mode === 'hardware' ? 'green' : isConnected ? 'yellow' : 'grey'}`}></span>
                </span>
                <span style={{ fontFamily: 'monospace', fontWeight: 'bold', fontSize: 11 }}>
                  {isConnected ? (hw?.mode === 'hardware' ? `USB ${hw.port?.replace('/dev/cu.', '')}` : 'backend simulator') : 'offline'}
                </span>
              </div>
            </div>
          </div>

          <div className="inspector-section" style={{ borderBottom: 'none' }}>
            <div className="inspector-title">Current Experiment</div>
            <div className="input-group">
              <label>Tracking Status</label>
              <div style={{ fontWeight: 'bold', fontSize: 11, color: trackingStatus === 'STABLE' ? 'var(--color-success)' : trackingStatus === 'SETTLING' || trackingStatus === 'IDLE' ? 'var(--color-warning)' : 'var(--color-danger)' }}>
                {trackingStatus}
              </div>
            </div>
            <div className="input-group" style={{ marginTop: 5 }}>
              <label>Active Mode</label>
              <div style={{ fontFamily: 'monospace', fontSize: 11 }}>
                {excitationSignal === 'None' ? 'Constant Target' : `Excitation: ${excitationSignal}`}
              </div>
            </div>
            {latest?.acl && (
              <div className="input-group" style={{ marginTop: 5 }}>
                <label>AI Health</label>
                <div style={{ fontFamily: 'monospace', fontSize: 11, fontWeight: 'bold', color: latest.acl === 'NORMAL' ? 'var(--color-success)' : latest.acl === 'LEARNING' ? 'var(--color-text-muted)' : 'var(--color-danger)' }}>
                  {latest.acl}
                </div>
              </div>
            )}
          </div>
        </aside>

      </div>
    </div>
  );
}
