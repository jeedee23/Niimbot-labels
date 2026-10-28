<!--
File: COPILOT_HANDOFF_NIIMBOT_M2_UBUNTU.md
Purpose: Handoff specification for GitHub Copilot to build a Linux-native NIIMBOT M2 label printer and workshop bin inventory application.
Version: 1.0
Created: 2026-10-28
Updated: 2026-10-28
-->

# GitHub Copilot Handoff — NIIMBOT M2 / Ubuntu Workshop Labels

## 0. Assignment

Build a **local, Linux-native Python desktop application** that (1) prints correctly on the user's **NIIMBOT M2 thermal-transfer label printer, 300 DPI** under Ubuntu; and (2) uses photographs of workshop sorter bins to build, verify, alphabetize, manage, and print a durable label inventory.

**Work sequentially. Printer connectivity and one verified physical test label are the first milestone.** Do not build the entire GUI before confirming a real working print path. The printer is already purchased, physically present, and prints well using the manufacturer's workflow. The photos of the bins will be supplied later: support an empty photo library and build photo import now; do not invent inventory entries.

The owner works primarily on Ubuntu GNOME/Wayland, VS Code + GitHub Copilot, and Python 3.12/3.13. Make no Windows-only assumptions. No subscription/cloud dependency. The user's primary language for UI is **Dutch**. Use English for code identifiers and technical docs.

## 1. Critical hardware facts, references, and uncertainty

- Purchased model described as **NIIMBOT M2**, 300 DPI, thermal transfer, Bluetooth and USB-C. The printer may advertise / identify as **M2_H**. **Query the physical device ID before assuming this equivalence.**
- M2_H community hardware data: model ID **4608 (0x1200)**, **300 DPI**, printhead **576 pixels / ~48 mm**, thermal transfer. Source: https://printers.niim.blue/hardware/niimbot-m2h/
- The independent, MIT-licensed project https://github.com/iscarelli/niimbot-web-bluetooth has **actually printed on the M2-H** and documents its protocol. Crucial reference files: `src/niimbot.js`, `registry.json`, `docs/protocol-v4.md`, `docs/NOTES.md`. Read their latest source before implementing a Python port.
- That project's M2-H uses the **`b1` print task at 300 DPI**, NOT automatically `v4` just because it is 300 DPI. The validated 50 x 30 mm stock example `T50x30_m2h` uses **567 x 354 px**; the reduced width is an intentional margin for ribbon drift, although the head itself is ~576 px wide. Adopt the model-specific size/profile, not a generic 300 DPI template.
- Documented BLE service UUID: `e7810a71-73ae-499d-8c15-faa9aef0c3f2`; characteristic UUID: `bef8d6c9-9c21-4c9e-b632-bd58c1009f9f` (NOTIFY + WRITE_NO_RESPONSE). Verify against actual device/updated driver before relying on these.
- Official downloads: https://www.niimbot.com/us/downloadCenter ; official pages list Windows/macOS/mobile software, but a **native Ubuntu driver has not been confirmed**. Do not promise that an official Linux installer exists.
- USB-C **may be for charging, data, or both depending on device/firmware**. Check `lsusb` and kernel logs before claiming USB printing works. Prefer a known-working **BLE** path.
- The media-identification chip detects consumables; **do not modify tags, firmware, or printer security**. Normal paper/ribbon status detection should continue to work.
- The existing open-source protocol is **not** a drop-in Python driver. It is a tested reference. If translating code, keep attribution and MIT license notice. Don't conflate different NIIMBOT model protocols.

## 2. Initial Ubuntu discovery (run this first; save results in docs/hardware-notes.md)

Inspect, without changing system configuration unnecessarily:

```bash
# File: ubuntu_m2_diagnostics.sh (commands to run interactively)
# Purpose: Identify OS, USB/Bluetooth interfaces, permissions and printer identity.
# Version: 1.0
# Created/Updated: 2026-10-28
cat /etc/os-release
python3 --version
lsusb
rfkill list
systemctl status bluetooth --no-pager
bluetoothctl list
bluetoothctl devices
journalctl -k -n 80 --no-pager
```

If Bluetooth is unavailable, troubleshoot BlueZ / adapter / rfkill first. Use `bluetoothctl scan on` interactively only when needed and stop scanning afterwards. Confirm the printer is turned on. If the phone NIIMBOT app occupies its BLE connection, disconnect it before the Ubuntu tests. Do not ask for blanket `sudo`, change sudoers, run the GUI as root, disable Bluetooth security, or install ad-hoc udev rules without evidence.

**Proof-of-protocol fallback:** In Chromium/Chrome under Linux, try the tested project's HTTPS demo: https://iscarelli.github.io/niimbot-web-bluetooth/demo/ (the Bluetooth chooser requires an explicit click). Use **Connect & identify** and, only after user approval, print one appropriate-size test label. This is a diagnostic bridge, not a replacement for the requested Python GUI. Log the reported device model ID, protocol, test result, and actual roll dimensions.

## 3. Milestone A — Native Python printing

1. Set up a Git repository and local virtual environment; create a `pyproject.toml` and README. Use `python3 -m venv .venv`; never `sudo pip install` into system Python. Proposed libraries: **bleak** (BLE via BlueZ), **Pillow** (raster rendering), **PySide6** (GUI), standard **sqlite3**. Add pytest and ruff as dev tools. Only add qasync or another bridge if needed.
2. Implement `PrinterTransport` interface. Start with **`NiimbotBleTransport`**, discover, connect, subscribe to notifications, identify model, read status, write packets, disconnect. Keep device I/O asynchronous and off the Qt main GUI thread. Robust timeout, retry, disconnect, and cancellation behavior.
3. Port/test only the required M2-H packet framing, authentication/connection handshake if required, print setup, bitmap encoding, flow control, progress, and completion sequence from the tested reference. Do not guess packet structure. Use traces and unit tests to verify encoding/checksums and notification parsing against documented examples.
4. Render a 1-bit test image with Pillow at the correct model/stock dimensions; text must be sharp at 300 DPI, orientation correct, with safe margins. Do **not** stretch the source image to a different aspect ratio. Convert **mm -> pixels = mm * 300 / 25.4** only for physical measurement; constrain to actual printable head width and stock profile.
5. Implement a CLI diagnostics/print path before Qt: `list-devices`, `info`, `test-print --stock <profile>`, `status` and clear logs. Print one test label **only following an explicit user action**. Never repeatedly feed/waste labels while recovering from an error.
6. Keep separate profiles for genuine M2 vs M2_H if discovery proves they differ. Never silently assume the profile if printer ID is unknown. Keep ribbon/paper type and density configurable with conservative defaults.
7. Investigate USB **only after** BLE is working, and only if Ubuntu reports a suitable data interface. A USB-C socket is not proof of USB printing. A CUPS queue is optional, not a prerequisite for raw BLE.

**Acceptance A:** The program detects and identifies the real printer under Ubuntu, reports connected/printing/errors, prints exactly one centered, legible 300 DPI test label, and can reconnect after the printer is switched off/on. Logs explain failure without crashing. If full native BLE support cannot be demonstrated, report the exact blocker and preserve the working browser proof-of-concept; do not claim finished driver support.

## 4. Milestone B — Inventory and photo-led workflow

The owner will provide **photos of many sorteerbakjes** (parts bins), including some similar-looking hardware. The goal is to **identify contents, label every bin, and reorganize/find them alphabetically**.

Core workflow:

1. Import multiple JPG/PNG/HEIC photos from the computer (HEIC optional if dependency available). Keep **original images unchanged**; make thumbnails and allow zoom/pan and crop per individual bin. Photos may show multiple bins, so one photo can link to several records.
2. Provide manual add/edit/merge/split of detected bins. Optional OCR (Tesseract) can propose readings where old labels are visible; later a vision-AI recognition plugin may propose component categories. **Never treat OCR or visual guesses as confirmed facts**. Every suggested part name must be manually reviewed before final inventory or printing.
3. For each bin, store: immutable bin ID, confirmed main name, synonyms/search terms, dimensions/specification, material, category, optional quantity, photograph/crop links, original current location (rack/shelf/position), planned new location, review status, printing status/date, and notes.
4. Support names such as `Inbusbout M4 x 20`, `Moer M6`, `Kabelschoen 2,5 mm2`, and material variants; show specifications separately when useful. Do not confuse `M3`, `M4`, and `M10`; support natural numeric sorting and Dutch case/accent-insensitive lookup, plus an explicit user-editable sort key.
5. Show a **before/after reorganization plan**. Alphabetical order is a sortable view, while physical location has its own independent field. **Keep stable IDs**: moving a bin must not invalidate previous references. Let the user adjust sort order and proposed slots before physically moving anything.
6. Search quickly by name, partial name, synonym, specification, or bin ID. Provide CSV import/export plus SQLite database backups. Never overwrite the existing inventory on import without a clear merge/review path.

**Acceptance B:** Import several photos, create/confirm at least five bin records, retrieve each by searching, and produce a trustworthy alphabetic list and physical move plan. No unconfirmed AI identification is presented as fact.

## 5. Milestone C — Label designer and print queue

- Build a native Dutch GUI with tabs/panels such as **Printer**, **Foto's**, **Inventaris**, **Etiketten**, **Instellingen**. Favor keyboard shortcuts, large readable preview, no cloud login.
- Default label layout: prominent component name, smaller size/material/details, optional compact stable ID / rack position. Support multiple templates and sizes **within the actual loaded roll capabilities**; print at 300 DPI with a 1:1 physical scale preview.
- Use simple high-contrast text, not decorative graphics. Long names must wrap or visibly warn before shrinking below readable size. Preserve accents and `Ø`, `×`, `µ`, `°` characters where font supports them; include fonts in rendering tests (not bundled proprietary fonts).
- Allow **Print one**, **Print selection**, **Print all confirmed in alphabetical order**, and **Reprint**; show queued/completed/error states. Preview every label. Do not print unverified records. Avoid accidental duplicate feeds or automatic retries without a confirmation.
- Keep ribbon monochrome per physical installed cassette. The user may install black or gold ribbon, but the application cannot create multicolor artwork from one ribbon.
- Do **not** hardcode assumptions about the label material. The owner has tested that stiff DYMO tapes spring back and fall from curved plastic bins, even with extra glue. Prefer flexible stock, including suitable thin paper when compatible. Adhesive is not the main issue; **no manual cutting** is acceptable. Preset die-cut labels are preferred; adhesive may be supplemented by a small amount of Magigoo. Do not require a separate commercial printer.

**Acceptance C:** Confirmed inventory names map to legible print previews, a selected label prints once and matches the preview/actual dimensions, and a checked batch can run in alphabetical order with progress/errors logged.

## 6. Proposed project structure

```text
niimbot-workshop-labels/
  README.md
  pyproject.toml
  .gitignore
  docs/
    COPILOT_HANDOFF_NIIMBOT_M2_UBUNTU.md
    hardware-notes.md
    protocol-references.md
  src/workshop_labels/
    __init__.py
    app.py
    ui/
    printer/
      transport.py
      niimbot_ble.py
      protocol.py
      profiles.py
    labels/
      renderer.py
      templates.py
      queue.py
    inventory/
      models.py
      repository.py
      import_photos.py
      sorting.py
  tests/
    test_protocol.py
    test_renderer.py
    test_inventory.py
  data/                 # local data; gitignored
  photos/               # originals stay local; gitignored
```

Choose a clean but not overengineered architecture. SQLite records should be created by versioned migrations; commit code, tests and docs, not personal photos, MAC addresses or inventory backups. Unit tests should run without physical hardware using fake transport + sample data.

**Every Python source or shell script begins with a comment header** identifying filename, purpose, version, and creation/update date. Increment/update when changed. Avoid generated files and caches in Git. Build incrementally and run smoke tests after each change.

## 7. Implementation sequence / Copilot operating instructions

- **Phase 1:** Inspect environment and repo; document real USB/BLE findings. Query actual printer ID, Bluetooth characteristics, paper size, firmware info as supported. If possible validate with the existing browser demo. Show evidence of one real print. Do **not** modify firmware.
- **Phase 2:** Implement Python CLI BLE transport and 300 DPI label rendering, with tests and one verified physical print. Keep protocol citations/credits. Do not say "working" without output from actual hardware.
- **Phase 3:** Build PySide6 GUI around the working transport and preview.
- **Phase 4:** Add photo import and manual annotation; SQLite inventory and alphabetical physical move planner.
- **Phase 5:** Add optional OCR/vision suggestions, batch queue, exports and safeguards. Ensure photos are never uploaded to external services without explicit user consent.

At the end of every phase, provide: files changed; commands executed; actual observed output vs expectations; blocked/unverified features; next minimal task. Ask for a single short physical test when hardware verification is necessary. **Prioritize a functioning small app over an impressive, untested full app.**

## 8. References

1. Tested M2-H Web Bluetooth protocol (MIT): https://github.com/iscarelli/niimbot-web-bluetooth
2. M2-H hardware spec / 4608 / 300 DPI / 576 px: https://printers.niim.blue/hardware/niimbot-m2h/
3. NIIMBOT community protocol and devices: https://github.com/eigger/hass-niimbot/tree/master/docs
4. Official NIIMBOT download center: https://www.niimbot.com/us/downloadCenter
5. Upstream NiimBlueLib docs (check license and usage caveats): https://libdocs.niim.blue/index.html

## 9. First instruction to GitHub Copilot

**Start with Phase 1 only.** Inspect the Ubuntu machine, identify the connected NIIMBOT M2/M2_H, and establish the safest path to a single test label. Show the diagnostic results, what they prove, and the exact minimal next implementation step. Do not start the full photo GUI before a genuine printing test succeeds.
