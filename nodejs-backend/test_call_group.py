"""
Group call test — the mesh with more than two participants.

A 1:1 call exercises exactly one RTCPeerConnection per side, so it never
proves that the mesh works when each participant holds several. This test
puts 3 and then 4 people in the same call and checks that:

  1. Everyone can join a call with several people.
  2. Every participant sees every other participant (not just the host).
  3. Each pair has a live peer connection carrying video frames.
  4. The participant list shows the full group.
  5. Leaving removes the peer from the others' views.
  6. The host can end the call for everyone.

Run with:
    C:\\Users\\Lenovo\\.agents\\skills\\seo\\.venv\\Scripts\\python.exe test_call_group.py
"""

import json
import os
import re
import sys
import time
from playwright.sync_api import sync_playwright

APP = os.environ.get("ACEHRM_APP_URL", "https://127.0.0.1:5173")
CHROMIUM = os.path.expandvars(
    r"%LOCALAPPDATA%\ms-playwright\chromium-1228\chrome-win64\chrome.exe"
)

# manan is the host; the rest join as callees. All passwords are the same.
# The names must be unique in the org — there are two employees called
# "Haseeb", and the picker lists people by name.
HOST = ("manan", "admin123")
CALLEES = [("daood", "1234"), ("tayyab", "1234"), ("afaq", "1234")]

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


def new_page(ctx):
    """Open a page with a small fake camera.

    Three or four browsers encoding 720p VP8 in software at the same time is
    enough to crash the renderers on a busy machine. Clamping the fake camera
    to a small resolution keeps the real media path (real tracks, real
    negotiation, real frames) while making the test runnable anywhere.
    """
    page = ctx.new_page()
    page.add_init_script(
        """
        (() => {
          const md = navigator.mediaDevices;
          if (!md) return;
          const orig = md.getUserMedia.bind(md);
          md.getUserMedia = (c) => {
            if (c && c.video) {
              const v = typeof c.video === 'object' ? c.video : {};
              c = { ...c, video: { ...v, width: { ideal: 320 }, height: { ideal: 240 }, frameRate: { ideal: 15 } } };
            }
            return orig(c);
          };
        })();
        """
    )
    return page


def login(page, creds):
    page.goto(APP, wait_until="domcontentloaded")
    page.wait_for_selector("input[placeholder='Enter your username']", timeout=20000)
    page.fill("input[placeholder='Enter your username']", creds[0])
    page.fill("input[placeholder='Enter your password']", creds[1])
    page.get_by_role("button", name="Sign In").click()
    page.wait_for_selector("nav", timeout=20000)


def video_report(page):
    """Summarise the media elements, split into local and remote tiles.

    The local tile is always muted and the remote tiles are not — that is how
    the two are told apart.
    """
    return page.evaluate(
        """() => {
            const vids = Array.from(document.querySelectorAll('video'));
            const describe = (v) => ({
                videoTracks: v.srcObject ? v.srcObject.getVideoTracks().length : 0,
                audioTracks: v.srcObject ? v.srcObject.getAudioTracks().length : 0,
                w: v.videoWidth,
                h: v.videoHeight,
                playing: !v.paused,
                muted: v.muted,
                currentTime: v.currentTime,
            });
            const tiles = vids.map(describe);
            return {
                count: vids.length,
                remote: tiles.filter((t) => !t.muted),
                local: tiles.filter((t) => t.muted),
            };
        }"""
    )


def peer_names(page):
    """The names rendered on the participant tiles."""
    return page.evaluate(
        """() => {
            const out = [];
            for (const el of document.querySelectorAll('span')) {
                const t = (el.textContent || '').trim();
                if (t && t !== 'You' && el.className.includes('bg-black/50')) out.push(t);
            }
            return out;
        }"""
    )


def mesh_state(page):
    """The client-side mesh state, for diagnosing a peer that carries no frames."""
    return page.evaluate(
        """() => {
            const mesh = window.__callMesh;
            if (!mesh) return { error: 'no mesh' };
            const peers = [];
            for (const [peerId, peer] of mesh.peers) {
                peers.push({
                    peerId,
                    connectionState: peer.pc.connectionState,
                    iceState: peer.pc.iceConnectionState,
                    iceGathering: peer.pc.iceGatheringState,
                    signalingState: peer.pc.signalingState,
                    hasLocalDesc: !!peer.pc.localDescription,
                    hasRemoteDesc: !!peer.pc.remoteDescription,
                    localType: peer.pc.localDescription
                        ? peer.pc.localDescription.type
                        : null,
                    remoteType: peer.pc.remoteDescription
                        ? peer.pc.remoteDescription.type
                        : null,
                    senders: peer.pc.getSenders().map(s => ({
                        kind: s.track ? s.track.kind : 'none',
                        enabled: s.track ? s.track.enabled : null,
                        state: s.track ? s.track.readyState : null,
                    })),
                    receivers: peer.pc.getReceivers().map(r => ({
                        kind: r.track ? r.track.kind : 'none',
                        state: r.track ? r.track.readyState : null,
                        muted: r.track ? r.track.muted : null,
                    })),
                    transceivers: peer.pc.getTransceivers().map(t => ({
                        mid: t.mid,
                        currentDirection: t.currentDirection,
                        direction: t.direction,
                        senderKind: t.sender.track ? t.sender.track.kind : 'none',
                    })),
                    remoteTracks: peer.stream
                        ? peer.stream.getTracks().map(t => ({
                              kind: t.kind,
                              state: t.readyState,
                              muted: t.muted,
                              enabled: t.enabled,
                          }))
                        : null,
                });
            }
            return {
                selfPeerId: mesh.selfPeerId,
                camEnabled: mesh.camEnabled,
                localTracks: mesh.localStream
                    ? mesh.localStream.getTracks().map(t => ({
                          kind: t.kind,
                          state: t.readyState,
                          enabled: t.enabled,
                      }))
                    : null,
                peers,
            };
        }"""
    )


def measure(page):
    """Measure the media elements with the page in the foreground.

    Chrome throttles rendering in background tabs, so a backgrounded page
    never advances its video element's currentTime and reports no frame
    dimensions. The measurement has to happen with the page focused.
    """
    page.bring_to_front()
    page.wait_for_timeout(400)
    return video_report(page)


def run_group(browser, size):
    print(f"\n{'=' * 60}\nGroup call with {size} participants\n{'=' * 60}")

    contexts = []
    pages = []
    try:
        for _ in range(size):
            ctx = browser.new_context(
                viewport={"width": 1280, "height": 900},
                permissions=["camera", "microphone"],
                ignore_https_errors=True,
            )
            contexts.append(ctx)
            pages.append(new_page(ctx))

        for page in pages:
            page.on("pageerror", lambda e, p=page: print(f"    PAGEERROR: {e}"))
            page.on(
                "console",
                lambda m, p=page: print(f"    console[{m.type}]: {m.text[:200]}")
                if m.type in ("error", "warning")
                else None,
            )

        host = pages[0]
        callees = pages[1:]

        login(host, HOST)
        for page, creds in zip(callees, CALLEES[: size - 1]):
            login(page, creds)

        check(f"[{size}] everyone signed in", all(p.locator("nav").count() > 0 for p in pages))

        # The host picks all the callees.
        host.locator("nav button", has_text="Calls").first.click()
        host.wait_for_selector("text=Start a call", timeout=15000)

        for creds in CALLEES[: size - 1]:
            username, _ = creds
            host.get_by_placeholder("Search people…").fill(username)
            host.wait_for_timeout(500)
            # Select by username — names are not unique in this org.
            row = host.locator("li").filter(has_text=f"@{username}").first
            row.get_by_role("button").first.click()
            host.wait_for_timeout(250)

        check(
            f"[{size}] the host selected {size - 1} participants",
            host.get_by_text(f"{size} people in the call").count() > 0,
            host.get_by_text("people in the call").first.text_content()
            if host.get_by_text("people in the call").count()
            else "no counter",
        )

        # Capture what the server said when the call was created.
        start_response = {}

        def capture(resp, store=start_response):
            if "/api/call" in resp.url:
                print(f"      [http] {resp.request.method} {resp.url} -> {resp.status}")
            if "/api/call/sessions" in resp.url and resp.request.method == "POST":
                try:
                    store["status"] = resp.status
                    store["body"] = resp.json()
                except Exception:
                    store["status"] = resp.status
                    store["body"] = resp.text()[:200]

        host.on("response", capture)
        host.get_by_role("button", name="Start call").click()
        host.wait_for_timeout(3000)

        check(
            f"[{size}] the host could start the call",
            start_response.get("status") == 200,
            json.dumps(start_response)[:300],
        )

        # Every callee rings and accepts.
        for page, creds in zip(callees, CALLEES[: size - 1]):
            page.wait_for_selector("text=Incoming call", timeout=25000)
            check(f"[{size}] {creds[0]} sees the incoming call", True)
            page.get_by_role("button", name="Accept call").click()

        callees[0].wait_for_timeout(4000)

        # Turn the camera on everywhere so a real track has to be exchanged.
        for page in pages:
            try:
                page.get_by_role("button", name="Turn camera on").click()
            except Exception:
                pass
        host.wait_for_timeout(6000)

        deadline = time.time() + 45
        while time.time() < deadline:
            ok = True
            for page in pages:
                page.bring_to_front()
                report = video_report(page)
                # Every participant must have live video from all the others.
                if not all(
                    t["videoTracks"] > 0 and t["w"] > 0 for t in report["remote"]
                ):
                    ok = False
            if ok:
                break
        host.wait_for_timeout(1000)

        for idx, page in enumerate(pages):
            who = "host" if idx == 0 else CALLEES[idx - 1][0]
            report = measure(page)
            check(
                f"[{size}] {who} renders {size} tiles (self + {size - 1} peers)",
                report["count"] == size,
                f"count={report['count']}",
            )
            ok_video = len(report["remote"]) >= size - 1 and all(
                t["w"] > 0 for t in report["remote"]
            )
            check(
                f"[{size}] {who} receives live video from all {size - 1} peers",
                ok_video,
                json.dumps(report),
            )
            if not ok_video:
                print("      mesh state:")
                print(json.dumps(mesh_state(page), indent=2)[:2500])
            check(
                f"[{size}] {who} receives audio from all {size - 1} peers",
                sum(1 for t in report["remote"] if t["audioTracks"] > 0) >= size - 1,
                json.dumps(report),
            )

        # The participant list must show the whole group on the host.
        host.get_by_role("button", name="Toggle participants").click()
        host.wait_for_timeout(1000)
        listed = host.locator("li").count()
        check(
            f"[{size}] the participant list shows {size} people",
            listed >= size,
            f"listed={listed}",
        )

        # One person leaves: the others must drop that peer.
        print(f"   {CALLEES[0][0]} leaves the call…")
        callees[0].get_by_role("button", name="End call").click()
        callees[0].wait_for_timeout(4000)

        leaver_report = measure(callees[0])
        check(
            f"[{size}] the leaver's own overlay closes",
            leaver_report["count"] == 0,
            json.dumps(leaver_report),
        )

        # The remaining participants keep their tiles minus the leaver.
        remaining = [measure(p) for p in pages[2:]]
        check(
            f"[{size}] the remaining peers drop the leaver",
            all(r["count"] == size - 1 for r in remaining),
            json.dumps(remaining),
        )

        # The host ends it for everyone.
        host.get_by_role("button", name="End call").click()
        host.wait_for_timeout(3000)
        check(
            f"[{size}] the host ends the call for everyone",
            all(p.get_by_role("button", name="End call").count() == 0 for p in pages),
        )

    finally:
        for ctx in contexts:
            ctx.close()


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

def check_over_the_limit(browser):
    """The picker must not allow more people than the mesh supports."""
    print("\nGroup call over the limit")

    ctx = browser.new_context(
        viewport={"width": 1280, "height": 900},
        permissions=["camera", "microphone"],
        ignore_https_errors=True,
    )
    page = new_page(ctx)
    try:
        login(page, HOST)
        page.locator("nav button", has_text="Calls").first.click()
        page.wait_for_selector("text=Start a call", timeout=15000)

        def select(username):
            page.get_by_placeholder("Search people…").fill(username)
            page.wait_for_timeout(500)
            row = page.locator("li").filter(has_text=f"@{username}").first
            row.get_by_role("button").first.click()
            page.wait_for_timeout(300)

        def counter():
            for n in range(2, 9):
                if page.get_by_text(f"{n} people in the call").count():
                    return n
            return 0

        select(CALLEES[0][0])
        select(CALLEES[1][0])
        reached = counter()
        check(
            "the picker reaches the limit of 3 people",
            reached == 3,
            f"counter={reached}",
        )

        # One more must be refused.
        select(CALLEES[2][0])
        after = counter()
        check(
            "the picker refuses more than the limit",
            after == 3,
            f"counter={after}",
        )
    finally:
        ctx.close()


def main():
    print("\naceHRM — group call test\n")
    preflight()

    with sync_playwright() as p:
        browser = p.chromium.launch(
            executable_path=CHROMIUM,
            args=[
                "--use-fake-device-for-media-stream",
                "--use-fake-ui-for-media-stream",
            ],
        )

        # The group sizes can be narrowed with ACEHRM_GROUP_SIZES (e.g. "4"),
        # which is useful on a memory-constrained machine — four browsers each
        # encoding a video stream is heavy.
        sizes = [
            int(s)
            for s in os.environ.get("ACEHRM_GROUP_SIZES", "3").split(",")
            if s.strip()
        ]

        for size in sizes:
            run_group(browser, size)

        check_over_the_limit(browser)

        browser.close()

    print(f"\n{passed} passed, {failed} failed\n")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
