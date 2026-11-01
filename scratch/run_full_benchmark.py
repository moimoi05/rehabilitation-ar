import asyncio
import json
import os
import sys
import subprocess
import time
import httpx
import websockets

EDGE_PATH = r'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
USER_DATA = r'D:\rehabilitation\rehabilitation-ar\edge-profile'
URL = 'http://127.0.0.1:5174/tracking-benchmark'

async def run(selected_arg="2"):
    print(f"=== Starting Edge Benchmark Runner (Target: {selected_arg}) ===", flush=True)
    
    # Generate unique profile subfolder per run if needed to prevent edge lock
    run_profile = os.path.join(USER_DATA, f"profile_{int(time.time())}")
    os.makedirs(run_profile, exist_ok=True)

    print("Spawning Microsoft Edge with remote debugging and hardware acceleration...", flush=True)
    cmd = [
        EDGE_PATH,
        '--remote-debugging-port=9222',
        f'--user-data-dir={run_profile}',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-features=CalculateNativeWinOcclusion',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
        '--disable-background-timer-throttling',
        '--autoplay-policy=no-user-gesture-required',
        '--start-maximized',
        URL
    ]
    proc = subprocess.Popen(cmd)
    
    ws_url = None
    for attempt in range(30):
        await asyncio.sleep(1)
        try:
            async with httpx.AsyncClient() as client:
                r = await client.get('http://127.0.0.1:9222/json', timeout=2.0)
                for tab in r.json():
                    if tab.get('type') == 'page' and 'tracking-benchmark' in tab.get('url', ''):
                        ws_url = tab.get('webSocketDebuggerUrl')
                        break
                if ws_url:
                    break
        except Exception:
            pass

    if not ws_url:
        print("ERROR: Could not attach to Microsoft Edge via CDP", flush=True)
        if proc: proc.terminate()
        return 1

    print(f"Attached to Edge CDP: {ws_url}", flush=True)
    async with websockets.connect(ws_url, max_size=32*1024*1024) as ws:
        msg_id = 0
        async def call(method, params=None):
            nonlocal msg_id
            msg_id += 1
            req_id = msg_id
            payload = {'id': req_id, 'method': method}
            if params:
                payload['params'] = params
            await ws.send(json.dumps(payload))
            while True:
                raw = await ws.recv()
                msg = json.loads(raw)
                if msg.get('id') == req_id:
                    return msg.get('result', {})

        await call('Runtime.enable')
        await call('Page.enable')

        # Override document.hidden and set bypass flag
        await call('Page.addScriptToEvaluateOnNewDocument', {
            'source': """
                window.__BENCHMARK_IGNORE_HIDDEN__ = true;
                Object.defineProperty(document, 'hidden', { get: () => false, configurable: true });
                Object.defineProperty(document, 'visibilityState', { get: () => 'visible', configurable: true });
            """
        })
        await call('Runtime.evaluate', {
            'expression': """
                window.__BENCHMARK_IGNORE_HIDDEN__ = true;
                Object.defineProperty(document, 'hidden', { get: () => false, configurable: true });
                Object.defineProperty(document, 'visibilityState', { get: () => 'visible', configurable: true });
            """
        })
        await call('Page.bringToFront')

        # Wait for page status to indicate ready
        print("Waiting for video metadata and ready status...", flush=True)
        ready = False
        for _ in range(40):
            await asyncio.sleep(1)
            res = await call('Runtime.evaluate', {
                'expression': 'document.querySelector("p[role=\'status\']")?.textContent || ""',
                'returnByValue': True
            })
            text = res.get('result', {}).get('value', '')
            if 'Sẵn sàng' in text or 'San sang' in text:
                ready = True
                break

        if not ready:
            print(f"ERROR: Page failed to become ready in time (Status: {text})", flush=True)
            if proc: proc.terminate()
            return 1

        print("Page is ready!", flush=True)

        # Select configuration
        res = await call('Runtime.evaluate', {
            'expression': f"""
            const sel = document.querySelector('select[aria-label="Cấu hình benchmark"]');
            sel.value = "{selected_arg}";
            sel.dispatchEvent(new Event('change', {{ bubbles: true }}));
            sel.value;
            """,
            'returnByValue': True
        })
        print(f"Selected configuration value: {res.get('result', {}).get('value')}", flush=True)

        # Start benchmark
        print("Triggering benchmark execution...", flush=True)
        res = await call('Runtime.evaluate', {
            'expression': """
            const btn = Array.from(document.querySelectorAll('button')).find(b => b.textContent.includes('Bắt đầu benchmark'));
            if (btn && !btn.disabled) { btn.click(); true; } else { false; }
            """,
            'returnByValue': True
        })
        val = res.get('result', {}).get('value')
        print(f"Clicked Start button: {val}", flush=True)

        # Monitor loop
        last_status = ""
        prev_results_count = 0
        timeout_seconds = 800 if selected_arg == "suite" else 90
        start_time = time.time()
        
        while time.time() - start_time < timeout_seconds:
            await asyncio.sleep(2)
            
            # Fetch status text
            res = await call('Runtime.evaluate', {
                'expression': 'document.querySelector("p[role=\'status\']")?.textContent || ""',
                'returnByValue': True
            })
            status_text = res.get('result', {}).get('value', '')
            if status_text != last_status:
                print(f"[{time.strftime('%H:%M:%S')}] {status_text}", flush=True)
                last_status = status_text

            # Fetch list of completed results
            res = await call('Runtime.evaluate', {
                'expression': 'Array.from(document.querySelectorAll("ul li")).map(li => li.innerText)',
                'returnByValue': True
            })
            items = res.get('result', {}).get('value', [])
            if len(items) > prev_results_count:
                for item in items[prev_results_count:]:
                    print(f"\n>>> RUN RESULT COMPLETED: {item}\n", flush=True)
                prev_results_count = len(items)

            # Check if all done
            if selected_arg != "suite" and prev_results_count >= 1:
                print("Single benchmark run completed!", flush=True)
                break
            if selected_arg == "suite" and prev_results_count >= 15:
                print("All 15 suite benchmark runs completed!", flush=True)
                break
            if 'Đã kết thúc' in last_status or 'Da ket thuc' in last_status:
                print("Benchmark runner reached completion status.", flush=True)
                break

    print("Finished CDP session.", flush=True)
    if proc:
        proc.terminate()
    return 0

if __name__ == '__main__':
    target = sys.argv[1] if len(sys.argv) > 1 else "2"
    code = asyncio.run(run(target))
    sys.exit(code)
