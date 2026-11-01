import asyncio
import json
import os
import subprocess
import time
import httpx
import websockets

EDGE_PATH = r'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
USER_DATA = r'D:\rehabilitation\rehabilitation-ar\edge-profile'
URL = 'http://127.0.0.1:5174/tracking-benchmark'

async def main():
    print("Launching Edge...")
    proc = subprocess.Popen([
        EDGE_PATH,
        '--remote-debugging-port=9222',
        f'--user-data-dir={USER_DATA}',
        '--no-first-run',
        '--no-default-browser-check',
        '--window-size=1600,1000',
        URL
    ])
    
    ws_url = None
    for attempt in range(20):
        await asyncio.sleep(1)
        try:
            async with httpx.AsyncClient() as client:
                r = await client.get('http://127.0.0.1:9222/json')
                tabs = r.json()
                for tab in tabs:
                    if tab.get('type') == 'page' and 'tracking-benchmark' in tab.get('url', ''):
                        ws_url = tab.get('webSocketDebuggerUrl')
                        break
                if ws_url:
                    break
        except Exception:
            pass

    if not ws_url:
        print("Failed to find Edge CDP tab")
        proc.terminate()
        return

    print("Connected to CDP:", ws_url)
    async with websockets.connect(ws_url, max_size=10*1024*1024) as ws:
        msg_id = 0
        async def send(method, params=None):
            nonlocal msg_id
            msg_id += 1
            payload = {'id': msg_id, 'method': method}
            if params:
                payload['params'] = params
            await ws.send(json.dumps(payload))
            return msg_id

        await send('Runtime.enable')
        await send('Page.enable')
        await send('Console.enable')

        # Wait for status to become "Sẵn sàng"
        print("Waiting for page ready...")
        ready = False
        for _ in range(30):
            await asyncio.sleep(1)
            eval_id = await send('Runtime.evaluate', {
                'expression': 'document.querySelector("p[role=\'status\']")?.textContent || ""',
                'returnByValue': True
            })
            while True:
                resp = json.loads(await ws.recv())
                if resp.get('id') == eval_id:
                    text = resp.get('result', {}).get('result', {}).get('value', '')
                    print("Page status:", repr(text))
                    if 'Sẵn sàng' in text or 'San sang' in text:
                        ready = True
                    break
            if ready:
                break

        if not ready:
            print("Page not ready in time")
            return

        print("Page is ready! Testing configuration selection...")
        # Select configuration 2: 'B/F GPU main Pose + Hand #1'
        select_id = await send('Runtime.evaluate', {
            'expression': """
            const sel = document.querySelector('select[aria-label="Cấu hình benchmark"]');
            sel.value = "2";
            sel.dispatchEvent(new Event('change', { bubbles: true }));
            sel.value;
            """,
            'returnByValue': True
        })
        while True:
            resp = json.loads(await ws.recv())
            if resp.get('id') == select_id:
                print("Selected configuration index:", resp.get('result', {}).get('result', {}).get('value'))
                break

        # Click Start benchmark button
        print("Clicking Start benchmark button...")
        click_id = await send('Runtime.evaluate', {
            'expression': """
            const btn = Array.from(document.querySelectorAll('button')).find(b => b.textContent.includes('Bắt đầu benchmark'));
            if (btn && !btn.disabled) { btn.click(); true; } else { false; }
            """,
            'returnByValue': True
        })
        while True:
            resp = json.loads(await ws.recv())
            if resp.get('id') == click_id:
                print("Clicked start:", resp.get('result', {}).get('result', {}).get('value'))
                break

        # Monitor run progress
        print("Monitoring benchmark run...")
        start_time = time.time()
        last_status = ""
        while time.time() - start_time < 90:
            await asyncio.sleep(2)
            stat_id = await send('Runtime.evaluate', {
                'expression': 'document.querySelector("p[role=\'status\']")?.textContent || ""',
                'returnByValue': True
            })
            while True:
                resp = json.loads(await ws.recv())
                if resp.get('id') == stat_id:
                    curr_status = resp.get('result', {}).get('result', {}).get('value', '')
                    if curr_status != last_status:
                        print("Status update:", curr_status)
                        last_status = curr_status
                    break
            
            # Check results list
            res_id = await send('Runtime.evaluate', {
                'expression': """
                Array.from(document.querySelectorAll('ul li')).map(li => li.textContent)
                """,
                'returnByValue': True
            })
            while True:
                resp = json.loads(await ws.recv())
                if resp.get('id') == res_id:
                    items = resp.get('result', {}).get('result', {}).get('value', [])
                    if items:
                        print("Run result item found:", items)
                        proc.terminate()
                        return
                    break

    proc.terminate()

if __name__ == '__main__':
    asyncio.run(main())
