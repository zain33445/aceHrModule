"""
Browser test for the call recording pipeline.

Runs a real call between two Chromium browsers, has both sides consent to the
recording, lets MediaRecorder capture actual audio, and then verifies that:

  1. The recording starts only after every participant consents.
  2. A single decline aborts the whole recording.
  3. The audio chunks are uploaded to the server.
  4. The server assembles the chunks into a playable file.
  5. The admin playback endpoint serves the assembled recording.
  6. The per-participant recording can be fetched.

Run with:
    C:\\Users\\Lenovo\\.agents\\skills\\seo\\.venv\\Scripts\\python.exe test_call_recording.py
"""

import json
import os
import re
import time
import urllib.request
from playwright.sync_api import sync_playwright

APP = os.environ.get("ACEHRM_APP_URL", "https://127.0.0.1:5173")
API = "http://localhost:5000/api"
CHROMIUM = os.path.expandvars(
    r"%LOCALAPPDATA%\ms-playwright\chromium-1228\chrome-win64\chrome.exe"
)

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


def login(page, creds):
    page.goto(APP, wait_until="domcontentloaded")
    page.wait_for_selector("input[placeholder='Enter your username']", timeout=20000)
    page.fill("input[placeholder='Enter your username']", creds[0])
    page.fill("input[placeholder='Enter your password']", creds[1])
    page.get_by_role("button", name="Sign In").click()
    page.wait_for_selector("nav", timeout=20000)


def api_json(method, path, token=None, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(API + path, data=data, method=method)
    req.add_header("Content-Type", "application/json")
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    with urllib.request.urlopen(req, timeout=15) as res:
        raw = res.read()
        return json.loads(raw) if raw else None


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
    print("\naceHRM — call recording browser test\n")
    preflight()

    with sync_playwright() as p:
        browser = p.chromium.launch(
            executable_path=CHROMIUM,
            args=[
                "--use-fake-device-for-media-stream",
                "--use-fake-ui-for-media-stream",
                "--autoplay-policy=no-user-gesture-required",
            ],
        )

        def ctx():
            c = browser.new_context(
                viewport={"width": 1280, "height": 900},
                permissions=["camera", "microphone"],
                ignore_https_errors=True,
            )
            c.grant_permissions(["camera", "microphone"], origin=APP)
            return c

        host = ctx().new_page()
        callee = ctx().new_page()

        for tag, page in (("HOST", host), ("CALLEE", callee)):
            page.on("pageerror", lambda e, t=tag: print(f"[{t} PAGEERROR] {e}"))

        login(host, ("manan", "admin123"))
        login(callee, ("daood", "1234"))

        host_token = host.evaluate(
            "() => JSON.parse(localStorage.getItem('bio_auth')).token"
        )
        callee_token = callee.evaluate(
            "() => JSON.parse(localStorage.getItem('bio_auth')).token"
        )

        # ── 1. Start a call ────────────────────────────────
        print("1. Starting a call")
        host.locator("nav button", has_text="Calls").first.click()
        host.wait_for_selector("text=Start a call", timeout=15000)
        host.get_by_placeholder("Search people…").fill("Daood")
        host.wait_for_timeout(400)
        host.get_by_role("button", name=re.compile("Daood")).first.click()
        host.wait_for_timeout(200)
        host.get_by_role("button", name="Start call").click()

        callee.wait_for_selector("text=Incoming call", timeout=20000)
        callee.get_by_role("button", name="Accept call").click()
        host.wait_for_timeout(2500)

        call_id = host.evaluate(
            """() => {
                const el = document.querySelector('[data-call-id]');
                return el ? el.getAttribute('data-call-id') : null;
            }"""
        )

        # The overlay does not expose the id, so read it from the server.
        sessions = api_json("GET", "/call/sessions?limit=1", host_token)
        call_id = sessions[0]["id"]
        check("the call is running", bool(call_id), json.dumps(sessions[0])[:120])

        # ── 2. One decline aborts the recording ────────────
        print("\n2. A decline aborts the recording")
        host.get_by_role("button", name="Record this call").click()
        callee.wait_for_selector("text=Record this call?", timeout=10000)
        check("the other participant is asked for consent", True)

        callee.get_by_role("button", name="Decline").click()
        host.wait_for_timeout(1500)
        check(
            "the host is told the recording was aborted",
            host.get_by_text("The recording was declined by a participant.").count() > 0,
        )

        # ── 3. Everybody agrees ────────────────────────────
        print("\n3. Everybody agrees to record")
        host.get_by_role("button", name="Record this call").click()
        callee.wait_for_selector("text=Record this call?", timeout=10000)
        callee.get_by_role("button", name="Agree to record").click()

        host.wait_for_timeout(2500)
        check(
            "the host sees the recording indicator",
            host.get_by_title("Stop recording").count() > 0,
        )
        check(
            "the callee sees the recording indicator",
            callee.get_by_title("Stop recording").count() > 0,
        )

        # Let MediaRecorder capture a few seconds of real audio.
        print("   capturing 4 seconds of audio…")
        time.sleep(4)

        # ── 4. Stop and upload ─────────────────────────────
        print("\n4. Stopping the recording")
        host.get_by_role("button", name="Stop recording").click()
        host.wait_for_timeout(4000)

        # ── 5. End the call so the server assembles ───────
        print("\n5. Ending the call (the server assembles the recording)")
        host.get_by_role("button", name="End call").click()
        host.wait_for_timeout(6000)

        # ── 6. Verify the recording on the server ─────────
        print("\n6. Verifying the assembled recording")
        recordings = api_json("GET", f"/call/recordings/call/{call_id}", host_token)
        check("the server has a recording for the call", len(recordings) > 0, json.dumps(recordings)[:200])

        if recordings:
            rec = recordings[0]
            check(
                "the recording is not empty",
                rec["file_size"] > 1000,
                f"size={rec['file_size']}",
            )

            # The playback endpoint must serve the mixed file.
            req = urllib.request.Request(API + f"/call/recordings/call/{call_id}/play")
            req.add_header("Authorization", f"Bearer {host_token}")
            with urllib.request.urlopen(req, timeout=20) as res:
                body = res.read()
                content_type = res.headers.get("Content-Type", "")
            check("the admin can play the mixed recording", len(body) > 1000, f"bytes={len(body)}")
            check(
                "the mixed recording is served as audio",
                "audio" in content_type,
                content_type,
            )
            check(
                "the recording is a WebM stream",
                body[:4] == b"\x1a\x45\xdf\xa3",
                body[:8].hex(),
            )

            # The per-participant file must be playable too.
            req = urllib.request.Request(API + f"/call/recordings/{rec['id']}/play")
            req.add_header("Authorization", f"Bearer {host_token}")
            with urllib.request.urlopen(req, timeout=20) as res:
                one = res.read()
            check("the per-participant recording can be fetched", len(one) > 1000, f"bytes={len(one)}")

            # A non-admin must not be able to read it.
            try:
                req = urllib.request.Request(API + f"/call/recordings/call/{call_id}/play")
                req.add_header("Authorization", f"Bearer {callee_token}")
                urllib.request.urlopen(req, timeout=10)
                check("a non-admin cannot read the recording", False, "request succeeded")
            except urllib.error.HTTPError as e:
                check("a non-admin cannot read the recording", e.code == 403, f"status={e.code}")

        # ── 7. The call history shows the call ────────────
        print("\n7. Call history")
        history = api_json("GET", "/call/history?limit=20", host_token)
        entry = [h for h in history if h["call_id"] == call_id]
        check("the call is in the history", len(entry) == 1)
        if entry:
            check("the call is recorded as answered", entry[0]["outcome"] == "answered", entry[0]["outcome"])
            check("the call has a duration", (entry[0]["duration_sec"] or 0) > 0, str(entry[0]["duration_sec"]))

        browser.close()

    print(f"\n{passed} passed, {failed} failed\n")
    return 1 if failed else 0


if __name__ == "__main__":
    import sys

    sys.exit(main())
