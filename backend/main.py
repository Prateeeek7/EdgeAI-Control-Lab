import asyncio
import json
import math
import os
import random
import threading
import time
from collections import deque
from typing import Dict, List, Optional, Set
from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

app = FastAPI(title="EdgeAI ControlLab Backend", version="1.0.0")

# Enable CORS for frontend Vite development server
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

import edge_ml
import runs_db

neural_tuner = edge_ml.NeuralTuner()


class RunData(BaseModel):
    operator: str = ""
    title: str = ""
    source: str = ""          # "ESP32-S3" or "simulator"
    controller: str = ""
    kp: float = 0
    ki: float = 0
    kd: float = 0
    metrics: Dict = {}
    model: Dict = {}
    samples: List[List[float]] = []   # [time, ref, output, input, current, temp]


class AutoTuneRequest(BaseModel):
    gain: float               # K, RPM per PWM step
    time_constant: float      # tau, s
    delay: int = 3            # samples (10 ms)


class SystemIDRequest(BaseModel):
    time: List[float]
    input: List[float]        # PWM
    output: List[float]       # RPM


# Motor simulator used when no ESP32 is configured. Plant and limits match the bench-identified
# JGA12-N20 (K 1.2 RPM/PWM, tau 60 ms, 30 ms delay) and the firmware (same PI law, same faults).
class MotorSimulation:
    K, TAU, DELAY = 1.2, 0.06, 3

    def __init__(self):
        self.true_speed = 0.0
        self.current_speed = 0.0
        self.integral = 0.0
        self.last_speed = 0.0
        self.u_buf = [0.0] * self.DELAY
        self.temp = 28.5
        self.kp, self.ki, self.kd = 0.2, 4.4, 0.0  # dashboard defaults (bench-validated)
        self.target_speed = 150.0
        self.controller_mode = "PID"
        self.excitation_signal = "None"
        self.time_index = 0
        self.is_estop = False
        self.stall_counter = 0
        self.fault = "NOMINAL"
        nn = neural_tuner.predict(self.K, self.TAU, self.DELAY)
        self.nn_kp, self.nn_ki = nn["kp"], nn["ki"]

    def _reference(self):
        t = self.time_index
        if self.excitation_signal == "Step":
            return 50.0 if (t // 100) % 2 == 0 else self.target_speed
        if self.excitation_signal in ("Sine Sweep", "Chirp"):
            t %= 2000
            return self.target_speed + math.sin(t * 0.05 * (0.2 + t / 500)) * 40
        if self.excitation_signal == "Impulse":
            return self.target_speed + 100.0 if t % 200 == 0 else self.target_speed
        return self.target_speed

    def step(self):
        a = math.exp(-0.01 / self.TAU)
        ref = 0.0 if self.is_estop else max(0.0, min(400.0, self._reference()))
        error = ref - self.current_speed
        gkp = gki = gkd = 0.0
        if self.is_estop:
            pwm = 0.0
            self.integral = 0.0
            self.fault = "ESTOP"
        elif self.fault in ("OVERCURRENT", "OVERHEAT", "STALL"):
            pwm = 0.0  # latched until the E-stop is toggled, like the firmware
        else:
            if self.controller_mode in ("PID", "Adaptive AI"):
                adaptive = self.controller_mode == "Adaptive AI"
                gkp, gki, gkd = (self.nn_kp, self.nn_ki, 0.0) if adaptive else (self.kp, self.ki, self.kd)
                d_rpm = (self.current_speed - self.last_speed) / 0.01
                unsat = gkp * error + gki * (self.integral + error * 0.01) - gkd * d_rpm
                if not ((unsat > 255 and error > 0) or (unsat < 0 and error < 0)):
                    self.integral = max(-400.0, min(400.0, self.integral + error * 0.01))
                pwm = gkp * error + gki * self.integral - gkd * d_rpm
            else:
                pwm = self.target_speed * 0.6
            pwm = max(0.0, min(255.0, pwm))
            self.fault = "NOMINAL"
        self.last_speed = self.current_speed

        self.u_buf.append(pwm)
        u = self.u_buf.pop(0)
        self.true_speed = a * self.true_speed + (1 - a) * self.K * u
        self.current_speed = max(0.0, self.true_speed + (random.random() - 0.5) * 0.6)

        current = max(0.0, 0.03 + 0.11 * pwm / 255 + (random.random() - 0.5) * 0.01) if pwm > 0 else 0.0
        power = current * current * 40 + 0.1 * self.current_speed / 300
        target_c = 28.5 + power * 25
        self.temp += (target_c - self.temp) * 0.01 / (90 if target_c > self.temp else 240)

        if self.fault == "NOMINAL":
            if current > 1.2:
                self.fault = "OVERCURRENT"
            elif self.temp > 58.0:
                self.fault = "OVERHEAT"
            elif pwm > 150 and self.current_speed < 15:
                self.stall_counter += 1
                if self.stall_counter > 50:
                    self.fault = "STALL"
            else:
                self.stall_counter = 0

        self.time_index += 1
        return {
            "time": round(self.time_index * 0.01, 2),
            "ref": round(ref, 1),
            "output": round(self.current_speed, 2),
            "input": round(pwm, 1),
            "error": round(error, 2),
            "current": round(current, 3),
            "temp": round(self.temp, 2),
            "fault": self.fault,
            "mode": self.controller_mode,
            "gKp": round(gkp, 3), "gKi": round(gki, 3), "gKd": round(gkd, 3),
        }

@app.get("/api/status")
async def get_status():
    return {
        "status": "ONLINE",
        "mode": "hardware" if hardware else "simulator",
        "plant_type": "JGA12-N20 geared DC motor (12 V, 300 RPM)",
        "sample_rate_hz": 100,
        "active_database": f"SQLite ({os.path.relpath(runs_db.DB_PATH, os.path.dirname(__file__))})",
        "experiments_logged": runs_db.count(),
    }


@app.get("/api/hardware")
async def get_hardware():
    if not hardware:
        return {"mode": "simulator", "connected": False}
    return {
        "mode": "hardware",
        "port": hardware.ser.port,
        "baud": hardware.ser.baudrate,
        "connected": time.monotonic() - hardware.last_rx < 2.0,
        "info": hardware.info,
        "status_lines": list(hardware.status_lines),
    }


@app.get("/api/runs")
async def list_runs():
    return runs_db.list_runs()


@app.post("/api/runs")
async def save_run(run: RunData):
    return {"status": "SAVED", "id": runs_db.save_run(run.model_dump())}


@app.get("/api/runs/{run_id}")
async def get_run(run_id: int):
    run = runs_db.get_run(run_id)
    if not run:
        raise HTTPException(status_code=404, detail="run not found")
    return run


@app.delete("/api/runs/{run_id}")
async def delete_run(run_id: int):
    if not runs_db.delete_run(run_id):
        raise HTTPException(status_code=404, detail="run not found")
    return {"status": "DELETED"}


@app.post("/api/autotune")
async def autotune(req: AutoTuneRequest):
    # The same trained network the ESP32 runs, plus the analytic lambda rule for comparison.
    return {
        "status": "AUTO_TUNED_SUCCESS",
        "neural": neural_tuner.predict(req.gain, req.time_constant, req.delay),
        "lambda": edge_ml.lambda_rule(req.gain, req.time_constant, req.delay),
        "model": neural_tuner.report,
    }


@app.get("/api/nn_info")
async def nn_info():
    return neural_tuner.report


@app.post("/api/identify")
async def identify_plant(req: SystemIDRequest):
    try:
        result = edge_ml.identify(req.time, req.input, req.output)
    except ValueError as e:
        return {"status": "ERROR", "message": str(e)}
    return {"status": "IDENTIFICATION_SUCCESS", **result}

class StateSpaceRequest(BaseModel):
    gain: float
    time_constant: float

class FrequencyRequest(BaseModel):
    gain: float
    time_constant: float

@app.post("/api/state_space")
async def get_state_space(req: StateSpaceRequest):
    tau = req.time_constant
    K = req.gain
    if tau <= 0:
        tau = 0.15
        
    a_val = -1.0 / tau
    b_val = K / tau
    c_val = 1.0
    d_val = 0.0
    
    return {
        "status": "SUCCESS",
        "A": [[float(round(a_val, 4))]],
        "B": [[float(round(b_val, 4))]],
        "C": [[float(round(c_val, 4))]],
        "D": [[float(round(d_val, 4))]],
        "eigenvalues": [float(round(a_val, 4))],
        "controllability_matrix": [[float(round(b_val, 4))]],
        "observability_matrix": [[float(round(c_val, 4))]],
        "is_controllable": True,
        "is_observable": True
    }

@app.post("/api/frequency")
async def get_frequency_response(req: FrequencyRequest):
    tau = req.time_constant
    K = req.gain
    if tau <= 0:
        tau = 0.15
        
    points = []
    for i in range(50):
        log_w = -1.0 + (i / 49) * 3.0
        w = 10.0 ** log_w
        denom_mag = math.sqrt((w * tau) ** 2 + 1.0)
        mag = K / denom_mag
        mag_db = 20.0 * math.log10(mag) if mag > 0 else -100.0
        phase = -math.atan(w * tau) * (180.0 / math.pi)
        
        points.append({
            "frequency": float(round(w, 3)),
            "magnitude_db": float(round(mag_db, 2)),
            "phase": float(round(phase, 2))
        })
        
    return {
        "status": "SUCCESS",
        "bode_points": points,
        "gain_margin": "Infinite",
        "phase_margin": float(round(180.0 - 90.0, 1)),
        "bandwidth_rad_s": float(round(1.0 / tau, 3))
    }

# Real ESP32-S3 over USB serial (firmware/). Enabled by CONTROLLAB_SERIAL=/dev/cu.usbserial-XXXX;
# without it the /ws endpoint keeps running MotorSimulation.
class HardwareBridge:
    def __init__(self, port: str, baud: int):
        import serial  # pyserial, only needed in hardware mode

        self.ser = serial.Serial()
        self.port_hint = port
        self.ser.port = port
        self.ser.baudrate = baud
        self.ser.timeout = 0.1
        # ESP32-S3 native USB: RTS low = don't reset, DTR high = GPIO0 high, so any reset boots the
        # firmware rather than the ROM bootloader (DTR low + reset lands in "waiting for download").
        self.ser.dtr = True
        self.ser.rts = False
        self.connected = False
        self.write_lock = threading.Lock()
        self._open()
        self.clients: Set[WebSocket] = set()
        self.loop: Optional[asyncio.AbstractEventLoop] = None
        self.queue: Optional[asyncio.Queue] = None
        self.last_rx = 0.0  # time.monotonic() of the last telemetry line
        self.info: Dict = {}  # firmware "# info {...}" summary (config + sensor presence)
        self.status_lines: deque = deque(maxlen=12)  # latest human-readable status block

    def _open(self) -> bool:
        # The port can vanish (cable unplugged, motor noise resetting the USB link) and may come back
        # under a different name (/dev/cu.usbmodem101 vs ...1101 depending on the socket): try the
        # configured name first, then any ESP32-style USB modem port.
        import glob
        import serial
        candidates = [self.port_hint] + sorted(p for p in glob.glob("/dev/cu.usbmodem*") if p != self.port_hint)
        for port in candidates:
            try:
                self.ser.close()
                self.ser.port = port
                self.ser.dtr = True
                self.ser.rts = False
                self.ser.open()
                self.connected = True
                print(f"Hardware bridge: ESP32 on {port}")
                return True
            except (serial.SerialException, OSError):
                continue
        self.connected = False
        return False

    def start(self, loop: asyncio.AbstractEventLoop):
        self.loop = loop
        self.queue = asyncio.Queue(maxsize=500)
        threading.Thread(target=self._reader, daemon=True).start()
        loop.create_task(self._broadcast())
        loop.create_task(self._heartbeat())
        loop.create_task(self._link_watchdog())
        loop.create_task(self._status_poller())

    async def _status_poller(self):
        # Ask the firmware for its status block every 5 s (sensor presence, model, anomaly state).
        while True:
            await asyncio.to_thread(self._write, b"status\n")
            await asyncio.sleep(5.0)

    async def _link_watchdog(self):
        # Keep telemetry flowing: re-enable it if a bench session left it off ("tele off"), and if the
        # ESP32 still says nothing, it is probably sitting in the ROM bootloader -> reset into firmware.
        silent_since = time.monotonic()
        last_reset = 0.0
        while True:
            await asyncio.sleep(1.0)
            now = time.monotonic()
            if now - self.last_rx < 2.0:
                silent_since = now
                continue
            await asyncio.to_thread(self._write, b"\ntele on\n")
            if now - silent_since > 4.0 and now - last_reset > 10.0:
                print("Hardware bridge: no telemetry, resetting ESP32 into firmware")
                await asyncio.to_thread(self._reset_into_firmware)
                last_reset = now

    def _reset_into_firmware(self):
        if not self.connected:
            return
        with self.write_lock:
            self.ser.dtr = True   # GPIO0 high -> boot from flash, not the bootloader
            self.ser.rts = True   # EN low
            time.sleep(0.15)
            self.ser.rts = False

    async def _heartbeat(self):
        # The firmware stops the motor if it hears nothing for 1.5 s (see HOST_TIMEOUT_MS).
        while True:
            await asyncio.to_thread(self._write, b"ping\n")
            await asyncio.sleep(0.5)

    def _write(self, data: bytes):
        if not self.connected:
            return
        with self.write_lock:
            try:
                self.ser.write(data)
            except Exception:
                self.connected = False  # the reader thread reconnects

    def _reader(self):
        while True:
            if not self.connected:
                with self.write_lock:
                    ok = self._open()
                if not ok:
                    time.sleep(1.0)
                    continue
                self.loop.call_soon_threadsafe(self._enqueue, json.dumps({"log": f"HARDWARE: ESP32 reconnected on {self.ser.port}"}))
            try:
                raw = self.ser.readline()
            except Exception:
                if self.connected:
                    print("Hardware bridge: USB link lost, waiting for the ESP32 to come back")
                    self.loop.call_soon_threadsafe(self._enqueue, json.dumps({"log": "HARDWARE: USB link lost, reconnecting..."}))
                self.connected = False
                continue
            if not raw:
                continue
            line = raw.decode(errors="ignore").strip()
            if line.startswith("{"):
                self.last_rx = time.monotonic()
                self.loop.call_soon_threadsafe(self._enqueue, line)
            elif line.startswith("# info "):
                try:
                    self.info = json.loads(line[len("# info "):])
                except ValueError:
                    pass
            elif line.startswith(STATUS_PREFIXES):
                if line.startswith("# uptime"):
                    self.status_lines.clear()
                self.status_lines.append(line[2:])
            elif line.startswith("#"):
                # Firmware events (host link lost, model reset, sensor found...) go to the dashboard log.
                print(f"ESP32 {line}")
                self.loop.call_soon_threadsafe(self._enqueue, json.dumps({"log": line.lstrip("# ")}))

    def _enqueue(self, line: str):
        if self.queue.full():
            self.queue.get_nowait()
        self.queue.put_nowait(line)

    async def _broadcast(self):
        while True:
            line = await self.queue.get()
            for ws in list(self.clients):
                try:
                    await ws.send_text(line)
                except Exception:
                    self.clients.discard(ws)

    def send(self, packet: Dict):
        self._write((json.dumps(packet) + "\n").encode())


STATUS_PREFIXES = ("# uptime", "# sensors", "# mode=", "# encoder", "# temp source", "# id delay",
                   "# commands", "#   ", "# motor is IDLE")

hardware: Optional[HardwareBridge] = None


@app.on_event("startup")
async def open_hardware():
    global hardware
    port = os.environ.get("CONTROLLAB_SERIAL")
    if port:
        hardware = HardwareBridge(port, int(os.environ.get("CONTROLLAB_BAUD", "1000000")))
        hardware.start(asyncio.get_running_loop())
        print(f"Hardware bridge: ESP32 on {port}")


async def hardware_session(websocket: WebSocket):
    hardware.clients.add(websocket)
    print("WebSocket: Client connected (hardware mode).")
    try:
        while True:
            packet = json.loads(await websocket.receive_text())
            if "ping" in packet:  # dashboard link-latency probe: answer here, don't bother the ESP32
                await websocket.send_text(json.dumps({"pong": packet["ping"]}))
                continue
            await asyncio.to_thread(hardware.send, packet)
    except WebSocketDisconnect:
        print("WebSocket: Client disconnected.")
    finally:
        hardware.clients.discard(websocket)
        if not hardware.clients:
            # Nobody is watching the motor any more: stop it.
            await asyncio.to_thread(hardware.send, {"isEStop": True})


@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await websocket.accept()
    if hardware:
        await hardware_session(websocket)
        return
    simulator = MotorSimulation()
    print("WebSocket: Client connected.")
    
    try:
        while True:
            # Check for control inputs from client
            try:
                # Read without blocking indefinitely (timeout loop)
                data_str = await asyncio.wait_for(websocket.receive_text(), timeout=0.002)
                control_packet = json.loads(data_str)
                if "ping" in control_packet:
                    await websocket.send_text(json.dumps({"pong": control_packet["ping"]}))
                    continue

                # Update simulator configurations
                if "kp" in control_packet: simulator.kp = control_packet["kp"]
                if "ki" in control_packet: simulator.ki = control_packet["ki"]
                if "kd" in control_packet: simulator.kd = control_packet["kd"]
                if "targetSpeed" in control_packet: simulator.target_speed = control_packet["targetSpeed"]
                if "controllerMode" in control_packet: simulator.controller_mode = control_packet["controllerMode"]
                if "excitationSignal" in control_packet: simulator.excitation_signal = control_packet["excitationSignal"]
                if "isEStop" in control_packet:
                    if simulator.is_estop and not control_packet["isEStop"]:
                        simulator.fault = "NOMINAL"   # releasing the E-stop clears latched faults
                    simulator.is_estop = control_packet["isEStop"]
            except asyncio.TimeoutError:
                # No data received, continue simulation step
                pass

            # Advance simulation step (10ms dt)
            telemetry_point = simulator.step()

            # Broadcast telemetries to client
            await websocket.send_text(json.dumps(telemetry_point))
            
            # Sleep for 10ms to achieve 100 Hz frequency
            await asyncio.sleep(0.01)
            
    except WebSocketDisconnect:
        print("WebSocket: Client disconnected.")
    except Exception as e:
        print(f"WebSocket Error: {e}")
