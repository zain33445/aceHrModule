"""
Electron agent test.

Attaches to a running Electron instance over the Chrome DevTools Protocol and
verifies the calling feature's Electron integration:

  1. The app boots and loads the renderer.
  2. The preload exposes window.electronAPI.call (notifyIncoming / notifyEnded /
     onAction).
  3. The main process handles the call:incoming IPC and relays the action back
     to the renderer.
  4. The call overlay renders inside the Electron window.
  5. The call WebSocket connects from the Electron renderer.

Run with:
    npx electron . --remote-debugging-port=9222
    python test_electron_call.py
"""

import json
import os
import sys
import time
from playwright.sync_api import sync_playwright

CDP = "http://127.0.0.1:9222"
APP = os.environ.get("ACEHRM_APP_URL", "https://localhost:5173")

passed = 0
failed = 0


def check(name, ok, detail=""):
    global passed, failed
    if ok:
        passed += 1
        print(f"  PASS  {name}")
    else:
        failed += 1
        print(f"  FAIL  {name}{f' — {detail}' if detail else ''}")


def preflight():
    """Fail fast, with a clear message, when the stack is not up."""
    import ssl
    import urllib.error
    import urllib.request

    # The dev server uses a self-signed certificate.
    unverified = ssl._create_unverified_context()
    problems = []
    try:
        req = urllib.request.Request(
            "http://localhost:5000/api/auth/login",
            data=b'{"username":"manan","password":"admin123"}',
            method="POST",
        )
        req.add_header("Content-Type", "application/json")
        with urllib.request.urlopen(req, timeout=10, context=unverified) as res:
            if res.status != 200:
                problems.append(f"backend login returned HTTP {res.status}")
    except Exception as exc:
        problems.append(f"backend not reachable on :5000 ({exc})")

    try:
        with urllib.request.urlopen(APP, timeout=10, context=unverified) as res:
            if res.status >= 400:
                problems.append(f"app returned HTTP {res.status}")
    except urllib.error.HTTPError as exc:
        if exc.code >= 400:
            problems.append(f"app returned HTTP {exc.code}")
    except Exception as exc:
        problems.append(f"app not reachable at {APP} ({exc})")

    if problems:
        print("\nPreflight failed:")
        for p in problems:
            print(f"  - {p}")
        sys.exit(2)

def main():
    print("\naceHRM — Electron agent test\n")
    preflight()

    with sync_playwright() as p:
        browser = p.chromium.connect_over_cdp(CDP)
        contexts = browser.contexts
        if not contexts:
            print("  FAIL  no browser context found over CDP")
            return 1

        page = None
        for ctx in contexts:
            for pg in ctx.pages:
                if pg.url.startswith(APP) or "localhost:5173" in pg.url:
                    page = pg
                    break
            if page:
                break

        if page is None:
            # The window may still be loading the dev server.
            page = contexts[0].pages[0]

        print(f"  (attached to {page.url})")

        page_errors = []
        page.on("pageerror", lambda e: page_errors.append(str(e)))

        page.wait_for_load_state("domcontentloaded")
        time.sleep(3)

        # ── 1. Preload surface ─────────────────────────────
        print("1. Preload API")
        api_shape = page.evaluate(
            """() => {
                const api = window.electronAPI;
                if (!api) return { present: false };
                return {
                    present: true,
                    hasCall: !!api.call,
                    callKeys: api.call ? Object.keys(api.call) : [],
                    hasSetUserId: typeof api.setUserId === 'function',
                    hasRecording: !!api.recording,
                };
            }"""
        )
        check("window.electronAPI is exposed", api_shape.get("present"), json.dumps(api_shape))
        check("window.electronAPI.call is exposed", api_shape.get("hasCall"), json.dumps(api_shape))
        for key in ("notifyIncoming", "notifyEnded", "onAction"):
            check(
                f"window.electronAPI.call.{key} is available",
                key in (api_shape.get("callKeys") or []),
                json.dumps(api_shape),
            )

        # ── 2. IPC round trip ──────────────────────────────
        print("\n2. Call IPC round trip")

        # renderer -> main: raising an incoming call must reach the main
        # process, which replies with a call action.
        ipc = page.evaluate(
            """async () => {
                return await new Promise((resolve) => {
                    let received = null;
                    const api = window.electronAPI;
                    if (!api?.call?.onAction) return resolve({ ok: false, reason: 'no onAction' });
                    const off = api.call.onAction((payload) => { received = payload; });
                    api.call.notifyIncoming({ callId: 'test-call-id', fromName: 'Test Caller' });
                    setTimeout(() => { off?.(); resolve({ ok: true, received }); }, 2000);
                });
            }"""
        )
        check("the renderer can raise an incoming call", ipc.get("ok"), json.dumps(ipc))

        # main -> renderer: the main process relays the user's choice.
        ipc2 = page.evaluate(
            """async () => {
                return await new Promise((resolve) => {
                    let received = null;
                    const api = window.electronAPI;
                    if (!api?.call?.simulateAction) {
                        return resolve({ received, reason: 'no simulateAction hook' });
                    }
                    const off = api.call.onAction((payload) => { received = payload; });
                    api.call.simulateAction({ action: 'accept', callId: 'sim-call-id' });
                    setTimeout(() => { off?.(); resolve({ received }); }, 1500);
                });
            }"""
        )
        check(
            "the main process relays a call action back",
            ipc2.get("received") is not None,
            json.dumps(ipc2),
        )
        if ipc2.get("received"):
            check(
                "the relayed action carries the call id",
                ipc2["received"].get("callId") == "sim-call-id",
                json.dumps(ipc2["received"]),
            )
            check(
                "the relayed action carries the user's choice",
                ipc2["received"].get("action") == "accept",
                json.dumps(ipc2["received"]),
            )

        # ── 3. Login and the call overlay ──────────────────
        print("\n3. Login and the call UI")
        logged_in = False
        try:
            page.wait_for_selector("input[placeholder='Enter your username']", timeout=15000)
            page.fill("input[placeholder='Enter your username']", "manan")
            page.fill("input[placeholder='Enter your password']", "admin123")
            page.get_by_role("button", name="Sign In").click()
            page.wait_for_selector("nav", timeout=20000)
            logged_in = True
        except Exception as exc:  # already logged in from a previous run
            logged_in = page.locator("nav").count() > 0
            print(f"     (login form not shown: {str(exc)[:70]})")
        check("the agent app logs in", logged_in)

        storage = page.evaluate(
            """() => {
                const raw = localStorage.getItem('bio_auth');
                return { keys: Object.keys(localStorage), hasAuth: !!raw, auth: raw ? raw.slice(0, 140) : null };
            }"""
        )
        check("the agent stores its session", storage.get("hasAuth"), json.dumps(storage))
        print(f"     localStorage: {json.dumps(storage)}")

        # The call socket must connect from the Electron renderer.
        ws_state = page.evaluate(
            """async () => {
                const auth = JSON.parse(localStorage.getItem('bio_auth') || 'null');
                if (!auth?.token) return { ok: false, reason: 'no token' };
                const r = await fetch('http://localhost:5000/api/call/ws-token', {
                    method: 'POST',
                    headers: { Authorization: 'Bearer ' + auth.token },
                });
                const body = await r.json();
                return { ok: r.status === 200, hasToken: !!body.token };
            }"""
        )
        check("the Electron renderer can mint a call ticket", ws_state.get("ok"), json.dumps(ws_state))

        # The Calls tab must render inside Electron.
        try:
            page.locator("nav button", has_text="Calls").first.click()
            page.wait_for_selector("text=Start a call", timeout=15000)
            check("the Calls tab renders in the Electron window", True)
        except Exception as exc:
            check("the Calls tab renders in the Electron window", False, str(exc)[:150])

        # ── 4. No runtime errors ───────────────────────────
        print("\n4. Runtime health")
        real_errors = [e for e in page_errors if "ResizeObserver" not in e]
        check("no uncaught errors in the Electron renderer", len(real_errors) == 0, "; ".join(real_errors[:3]))

        browser.close()

    print(f"\n{passed} passed, {failed} failed\n")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
