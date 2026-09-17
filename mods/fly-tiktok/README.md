# Fly TikTok

A fruit fly's escape circuit, from the fly connectome, simulated live, watches your iPhone's TikTok
feed and swipes to the next video when something on screen startles it. 486 neurons around DNp01,
the giant fiber that triggers a fly's escape jump, see the phone's screen through the looming
detectors that feed it (LC4, LPLC2). A 3D fly stands on the phone, and the brain beside it lights up
neuron by neuron as they fire.

It's a Deep Steve app: turn on **Fly TikTok** in **Mods**, then open it from **Apps**. With no phone,
press **H** and tick **simulated screen** to watch the brain work on made-up motion.

## What you need

- A Mac, with Xcode installed.
- An iPhone with TikTok, and a USB cable to connect it to the Mac.
- An Apple ID. A free one works; it just has to re-sign the phone's test runner every 7 days.
- [libimobiledevice](https://libimobiledevice.org), for `iproxy`: `brew install libimobiledevice`

Nothing here asks for or stores a password, token or key. The only credential involved is your own
Apple ID, which you choose inside Xcode to sign WebDriverAgent for your phone.

## Set up the phone, once

The fly touches the phone through **WebDriverAgent**, which runs on the iPhone as a UI test and is
the only sanctioned way to inject touches into iOS. The Mac synthesizes no input at all.

1. **Connect your iPhone to your MacBook with a USB cable**, unlock it, and tap **Trust** when it
   asks about this computer.
2. On the phone: **Settings → Privacy & Security → Developer Mode** → on, and restart when asked.
3. Get WebDriverAgent and open it in Xcode:
   ```bash
   git clone https://github.com/appium/WebDriverAgent ~/WebDriverAgent
   open ~/WebDriverAgent/WebDriverAgent.xcodeproj
   ```
4. Select the **WebDriverAgentRunner** target → **Signing & Capabilities** → tick **Automatically
   manage signing** and choose **your own** team (your Apple ID). If Xcode says the bundle
   identifier is taken, change it to anything unique to you, like `com.yourname.wda`.
5. Pick your iPhone as the run destination, then **Product → Test** (⌘U). Keep the phone unlocked
   while it starts.
6. The first time only, on the phone: **Settings → General → VPN & Device Management** → trust your
   developer certificate, then run the test again.

When it's up, Xcode's log shows `ServerURLHere->http://…:8100<-ServerURLHere`. Leave it running.

## Every session

1. Connect the iPhone by USB, unlock it, and open TikTok's **For You** feed. Set **Auto-Lock** to
   **Never** while you use it: a locked phone sends no picture and takes no swipes.
2. Start WebDriverAgent from Xcode (step 5 above).
3. Start the phone bridge:
   ```bash
   node ~/.deepsteve/mods/fly-tiktok/phone/fly.mjs start
   ```
4. The first time, macOS asks to let **Phone USB Helper** use the **camera** and the **microphone**:
   allow both. The phone's screen and sound come over the cable as a capture device, which macOS
   files under those two permissions. Nothing records the Mac's camera or microphone, or the
   phone's microphone; the only input is the phone's own screen and playback.
5. Open **Fly TikTok** and press **Turn on**.

The badge on the phone in the app says what's missing, if anything: **USB not connected**,
**WebDriverAgent not running**, **Phone locked**, or **Mac needs camera permission**.

```bash
node ~/.deepsteve/mods/fly-tiktok/phone/fly.mjs status      # what's connected, and why time on task isn't counting
node ~/.deepsteve/mods/fly-tiktok/phone/fly.mjs arm         # the same as Turn on
node ~/.deepsteve/mods/fly-tiktok/phone/fly.mjs disarm
node ~/.deepsteve/mods/fly-tiktok/phone/fly.mjs log
node ~/.deepsteve/mods/fly-tiktok/phone/fly.mjs reset-time  # start time on task over
node ~/.deepsteve/mods/fly-tiktok/phone/fly.mjs stop
```

The phone's sound plays on the Mac, so a screen recording that captures the Mac's audio includes
TikTok's. `fly.mjs start -- --no-audio` leaves it off.

## Using it

- **The count** is videos swiped since you turned it on. **The clock** beside it is time on task,
  added up across runs: it counts only while the fly is on, the phone is connected and unlocked,
  WebDriverAgent is up and the app is open and visible, and dims when it isn't.
- **The brain** beside the phone holds still; drag to turn it, scroll or pinch to zoom,
  double-click to put it back. Each neuron sits at its cell body's real position in the
  connectome, at true scale, and flares when it spikes.
- **Compact** (top right) puts a smaller brain over the phone's video instead.
- **H** shows the tuning controls: gain, adaptation, spikes needed to escape, the simulated
  screen, and the brain drawn inside the fly.

## What makes it swipe

- **ESCAPE!** — something on screen changed suddenly (a cut, fast motion, something looming) and
  DNp01 fired. This is the circuit's own decision. The eye neurons respond to *changes* in motion:
  steady motion fades within about two seconds.
- **PAUSED → NEXT** — nothing on screen moved for 4 seconds, like a paused video or a photo post.
- **BORED → NEXT** — 20 seconds on one video without an escape. A calm video that moves gently is
  neither still nor startling, and would otherwise hold the fly forever.

The last two are timed rules, not the brain. TikTok reads watch time as interest, so the videos
the fly watches longest are the ones it teaches the feed to show more of.

## How it's built

- `brain.js` — the circuit as a spiking network (from the **Connectome** mod), fed with how much each
  patch of the phone's screen moves; decides when to move on.
- `cns.js`, `cns-view.js` — the brain and nerve cord in 3D.
- `phone/` — the bridge, which runs on the Mac, not in Deep Steve: `phone-usb.mjs` serves the app,
  `phone-usb-helper.swift` captures the phone's screen and sound (built and signed on first start),
  `fly.mjs` starts and stops it. Its log, PID and time on task live in `phone/.run/`.
- `fly.json`, `fly.bin` — the fly model from [flybody](https://github.com/TuragaLab/flybody)
  (`flybody.LICENSE`).
