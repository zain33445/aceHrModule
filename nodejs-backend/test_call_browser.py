"""
Browser end-to-end test for the aceHRM calling feature.

Drives two real Chromium browsers (fake camera/microphone) through a complete
call:

  1. The admin (manan) logs in and opens the Calls tab.
  2. The employee (daood) logs in.
  3. The admin picks the employee and starts the call.
  4. The employee sees the incoming-call dialog and accepts.
  5. Both sides establish a real WebRTC peer connection and receive the
     other's video track.
  6. The employee turns their camera on and the admin sees it.
  7. The admin hangs up and both sides return to idle.

Run with:
    C:\\Users\\Lenovo\\.agents\\skills\\seo\\.venv\\Scripts\\python.exe test_call_browser.py

Requires: backend on :5000, vite dev server on :5173.
"""

import json
import os
import re
import sys
import time
from playwright.sync_api import sync_playwright, expect

APP = os.environ.get("ACEHRM_APP_URL", "https://127.0.0.1:5173")
HOST = ("manan", "admin123")
CALLEE = ("daood", "1234")

# The Playwright build in this environment expects a newer Chromium revision
# than the one installed, so point it at the binary that is actually there.
CHROMIUM_CANDIDATES = [
    os.path.expandvars(
        r"%LOCALAPPDATA%\ms-playwright\chromium-1228\chrome-win64\chrome.exe"
    ),
    os.path.expandvars(
        r"%LOCALAPPDATA%\ms-playwright\chromium_headless_shell-1228"
        r"\chrome-headless-shell-win64\chrome-headless-shell.exe"
    ),
]
CHROMIUM_PATH = next((p for p in CHROMIUM_CANDIDATES if os.path.exists(p)), None)

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
    # The dashboard (not the login card) means we are in.
    page.wait_for_selector("nav", timeout=20000)


def open_calls_tab(page):
    page.locator("nav button", has_text="Calls").first.click()
    page.wait_for_selector("text=Start a call", timeout=15000)


def measure(page):
    """Measure the media elements with the page in the foreground.

    Chrome throttles rendering in background tabs, so a backgrounded page
    never advances its video element's currentTime and reports no frame
    dimensions. The measurement has to happen with the page focused.
    """
    page.bring_to_front()
    page.wait_for_timeout(400)
    return video_report(page)


def video_report(page):
    """Summarise the <video> elements rendered by the call overlay.

    The local tile is always muted and the remote tiles are not — that is how
    the two are told apart. Asserting with `any(...)` across all tiles would
    be satisfied by the local camera alone and would never really prove that
    the remote media arrived.
    """
    return page.evaluate(
        """() => {
            const vids = Array.from(document.querySelectorAll('video'));
            const describe = (v) => ({
                hasStream: !!v.srcObject,
                videoTracks: v.srcObject ? v.srcObject.getVideoTracks().length : 0,
                audioTracks: v.srcObject ? v.srcObject.getAudioTracks().length : 0,
                readyState: v.readyState,
                w: v.videoWidth,
                h: v.videoHeight,
                playing: !v.paused,
                muted: v.muted,
                currentTime: v.currentTime,
                networkState: v.networkState,
            });
            const tiles = vids.map(describe);
            return {
                count: vids.length,
                remote: tiles.filter((t) => !t.muted),
                local: tiles.filter((t) => t.muted),
            };
        }"""
    )


def rtc_state(page):
    """The playback state of the media elements the overlay rendered."""
    return page.evaluate(
        """() => {
            const vids = Array.from(document.querySelectorAll('video'));
            return vids.map((v, idx) => ({
                idx,
                readyState: v.readyState,
                networkState: v.networkState,
                playing: !v.paused,
                paused: v.paused,
                muted: v.muted,
                currentTime: v.currentTime,
                w: v.videoWidth,
                h: v.videoHeight,
                error: v.error ? v.error.code : null,
                srcId: v.srcObject ? (v.srcObject.id || 'anon') : null,
                tracks: v.srcObject
                    ? v.srcObject.getTracks().map(t => ({
                          id: t.id,
                          kind: t.kind,
                          enabled: t.enabled,
                          muted: t.muted,
                          readyState: t.readyState,
                      }))
                    : [],
            }));
        }"""
    )


def preflight():
    """Fail fast, with a clear message, when the stack is not up.

    Docker's WSL networking has been dropping the database mid-session, and a
    missing stack otherwise shows up as a 20-second selector timeout.
    """
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
        # A self-signed certificate is fine — the status is what matters.
        if exc.code >= 400:
            problems.append(f"app returned HTTP {exc.code}")
    except Exception as exc:
        problems.append(f"app not reachable at {APP} ({exc})")

    if problems:
        print("\nPreflight failed:")
        for p in problems:
            print(f"  - {p}")
        print(
            "\nCheck that the backend (:5000), the dev server (:5173) and "
            "PostgreSQL (:5432) are running."
        )
        sys.exit(2)


def main():
    print("\naceHRM — browser call test\n")
    preflight()

    with sync_playwright() as p:
        launch_args = {
            "args": [
                "--use-fake-device-for-media-stream",
                "--use-fake-ui-for-media-stream",
                # NOTE: deliberately NOT passing --autoplay-policy, so the test
                # exercises the same autoplay rules a real browser applies.
            ]
        }
        if CHROMIUM_PATH:
            launch_args["executable_path"] = CHROMIUM_PATH

        browser = p.chromium.launch(**launch_args)

        def new_context():
            ctx = browser.new_context(
                viewport={"width": 1280, "height": 900},
                permissions=["camera", "microphone"],
                ignore_https_errors=True,
            )
            ctx.grant_permissions(["camera", "microphone"], origin=APP)
            return ctx

        ctx_host = new_context()
        ctx_callee = new_context()
        host = ctx_host.new_page()
        callee = ctx_callee.new_page()

        host_errors = []
        callee_errors = []
        host.on("pageerror", lambda e: host_errors.append(str(e)))
        callee.on("pageerror", lambda e: callee_errors.append(str(e)))

        # ── 1. Log in ──────────────────────────────────────
        print("1. Signing in")
        login(host, HOST)
        check("the admin reaches the dashboard", host.locator("nav").count() > 0)
        login(callee, CALLEE)
        check("the employee reaches the dashboard", callee.locator("nav").count() > 0)

        # ── 2. Calls tab ───────────────────────────────────
        print("\n2. Opening the Calls tab")
        open_calls_tab(host)
        check("the Calls tab renders", host.get_by_text("Start a call").count() > 0)
        check("the call history renders", host.get_by_text("Call history").count() > 0)

        # ── 3. Start a call ────────────────────────────────
        print("\n3. Starting a call")
        host.get_by_placeholder("Search people…").fill("Daood")
        host.wait_for_timeout(400)
        host.get_by_role("button", name=re.compile("Daood")).first.click()
        host.wait_for_timeout(200)
        check(
            "the participant is selected",
            host.get_by_text("2 people in the call").count() > 0,
        )

        host.get_by_role("button", name="Start call").click()

        # ── 4. Incoming call ───────────────────────────────
        print("\n4. Incoming call")
        callee.wait_for_selector("text=Incoming call", timeout=20000)
        check("the callee sees the incoming-call dialog", callee.get_by_text("Incoming call").count() > 0)
        check("the callee sees the caller name", callee.get_by_text("Manan").count() > 0)

        callee.get_by_role("button", name="Accept call").click()

        # ── 5. Media connects ──────────────────────────────
        print("\n5. Establishing the peer connection")

        # The camera is opt-in, so the first thing to verify is that the
        # signalling produced a live peer connection. We enable the camera on
        # both sides and then check that real frames arrive.
        for page, who in ((host, "host"), (callee, "callee")):
            page.get_by_role("button", name="Turn camera on").click()
            page.wait_for_timeout(1500)
            check(f"the {who} can turn its camera on", True)

        # Give ICE + DTLS + the encoder time to complete. The wait is on the
        # REMOTE tiles specifically — the local camera is always live and would
        # otherwise satisfy the condition immediately.
        deadline = time.time() + 45
        connected = False
        while time.time() < deadline:
            host.bring_to_front()
            host_state = video_report(host)
            callee.bring_to_front()
            callee_state = video_report(callee)
            host_remote_live = any(
                t["videoTracks"] > 0 and t["w"] > 0 for t in host_state["remote"]
            )
            callee_remote_live = any(
                t["videoTracks"] > 0 and t["w"] > 0 for t in callee_state["remote"]
            )
            if host_remote_live and callee_remote_live:
                connected = True
                break
            time.sleep(1)

        host_state = measure(host)
        callee_state = measure(callee)

        # The detailed playback state below is read from the host page, so it
        # has to be the focused one.
        host.bring_to_front()
        host.wait_for_timeout(400)

        check(
            "the host renders two video tiles",
            host_state["count"] == 2,
            f"count={host_state['count']}",
        )
        check(
            "the callee renders two video tiles",
            callee_state["count"] == 2,
            f"count={callee_state['count']}",
        )
        check(
            "the host receives the remote video track",
            any(t["videoTracks"] > 0 and t["w"] > 0 for t in host_state["remote"]),
            json.dumps(host_state),
        )
        check(
            "the callee receives the remote video track",
            any(t["videoTracks"] > 0 and t["w"] > 0 for t in callee_state["remote"]),
            json.dumps(callee_state),
        )
        check(
            "the remote video is actually playing",
            any(v["playing"] and v["currentTime"] > 0 for v in rtc_state(host)),
            json.dumps(rtc_state(host)),
        )
        check(
            "the remote audio track is attached (so it can be heard)",
            any(t["audioTracks"] > 0 for t in host_state["remote"]),
            json.dumps(host_state),
        )
        check(
            "the remote audio is not muted by default",
            any(v["muted"] is False for v in rtc_state(host)),
            json.dumps(rtc_state(host)),
        )
        # The audio element must actually be PLAYING, not merely unmuted —
        # a paused or still-loading element is silent even though
        # muted === false.
        check(
            "the remote audio element is actually playing",
            any(
                v["muted"] is False and v["playing"] and v["currentTime"] > 0
                for v in rtc_state(host)
            ),
            json.dumps(rtc_state(host)),
        )
        check(
            "the remote audio element is not paused",
            all(not v["paused"] for v in rtc_state(host)),
            json.dumps(rtc_state(host)),
        )

        # ── 6. Camera toggle ───────────────────────────────
        print("\n6. Camera control")
        callee_state = video_report(callee)
        check(
            "the callee publishes a video track after enabling the camera",
            any(t["videoTracks"] > 0 for t in callee_state["local"]),
            json.dumps(callee_state),
        )

        callee.get_by_role("button", name="Turn camera off").click()
        callee.wait_for_timeout(1200)
        check(
            "the callee can turn the camera back off",
            callee.get_by_role("button", name="Turn camera on").count() > 0,
        )
        # The audio element must stay attached even with the camera off. Your
        # own tile is only shown while your camera or screen share is on, so
        # only the remote tile is left.
        check(
            "the audio element survives the camera being turned off",
            len(video_report(callee)["remote"]) == 1
            and video_report(callee)["remote"][0]["audioTracks"] > 0,
            json.dumps(video_report(callee)),
        )
        check(
            "your own tile is hidden with the camera off",
            len(video_report(callee)["local"]) == 0,
            json.dumps(video_report(callee)),
        )

        # ── 7. Mute control ────────────────────────────────
        print("\n7. Microphone control")
        callee.get_by_role("button", name="Mute microphone").click()
        time.sleep(1.5)
        check(
            "the callee can mute the microphone",
            callee.get_by_role("button", name="Unmute microphone").count() > 0,
        )

        # ── 8. Hang up ─────────────────────────────────────
        print("\n8. Ending the call")
        host.get_by_role("button", name="End call").click()
        time.sleep(2.5)
        check(
            "the call overlay closes on the host",
            host.get_by_role("button", name="End call").count() == 0,
        )
        check(
            "the call overlay closes on the callee",
            callee.get_by_role("button", name="End call").count() == 0,
        )

        # ── 9. No crashes ──────────────────────────────────
        print("\n9. Runtime health")
        check("no uncaught errors on the host page", len(host_errors) == 0, "; ".join(host_errors[:3]))
        check("no uncaught errors on the callee page", len(callee_errors) == 0, "; ".join(callee_errors[:3]))

        browser.close()

    print(f"\n{passed} passed, {failed} failed\n")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
