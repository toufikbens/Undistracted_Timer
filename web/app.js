// Wrap the app in a function so its variables do not leak into window.
(function () {
  "use strict";

  // One localStorage record holds timer state, preferences, and daily stats.
  const STORAGE_KEY = "undistracted-timer-state-v1";

  // Static information for each timer mode. The durationKey tells the app
  // which setting controls the length of that mode.
  const modes = {
    focus: {
      label: "Focus",
      durationKey: "focusMinutes",
      nextLabel: "short break",
      completeTitle: "Focus complete",
      completeMessage: "Time for a break."
    },
    short: {
      label: "Short break",
      durationKey: "shortMinutes",
      nextLabel: "focus",
      completeTitle: "Break complete",
      completeMessage: "Ready for another focus session."
    },
    long: {
      label: "Long break",
      durationKey: "longMinutes",
      nextLabel: "focus",
      completeTitle: "Long break complete",
      completeMessage: "Come back gently."
    }
  };

  const ambientSounds = {
    off: {
      label: "Off",
      tone: "Silence",
      categories: ["focus", "calm"]
    },
    lightRain: {
      label: "Light rain",
      tone: "Soft rain",
      categories: ["focus", "calm"],
      src: "assets/Light rain 1.mp3"
    },
    heavyRain: {
      label: "Heavy rain",
      tone: "Dense rain",
      categories: ["focus"],
      src: "assets/Heavy rain 1.mp3"
    },
    epicStorm: {
      label: "Epic storm",
      tone: "Rolling storm",
      categories: ["focus", "calm"],
      src: "assets/Epic-storm.mp3"
    }
  };

  // The default state is also the shape of the saved data we expect.
  // Durations are stored in seconds; settings are stored in minutes.
  const defaults = {
    mode: "focus",
    remaining: 25 * 60,
    currentDuration: 25 * 60,
    isRunning: false,
    endAt: null,
    completedInCycle: 0,
    todayKey: todayKey(),
    todayFocusSessions: 0,
    todayFocusMinutes: 0,
    settings: {
      focusMinutes: 25,
      shortMinutes: 5,
      longMinutes: 15,
      longEvery: 4,
      autoStart: true,
      sound: true,
      notifications: false,
      theme: "dark",
      ambientSound: "off",
      ambientSounds: [],
      ambientVolume: 42,
      ambientSoundVolumes: {}
    }
  };

  const AMBIENT_CROSSFADE_SECONDS = 8;
  const AMBIENT_LOOP_EDGE_GUARD_SECONDS = 3;
  const AMBIENT_LOOP_POLL_MS = 120;

  // Runtime state that changes while the page is open.
  let state = loadState();
  let tickHandle = null;
  let audioContext = null;
  let wakeLock = null;
  let lastAmbientTrigger = null;
  let autoStartHandle = null;
  let ambientState = {
    tracks: {}
  };

  // Cache DOM lookups once, then reuse these references throughout the app.
  const elements = {
    body: document.body,
    modeTabs: Array.from(document.querySelectorAll(".mode-tab")),
    modeLabel: document.getElementById("modeLabel"),
    timerTime: document.getElementById("timerTime"),
    nextLabel: document.getElementById("nextLabel"),
    statusText: document.getElementById("statusText"),
    themeToggleButton: document.getElementById("themeToggleButton"),
    themeToggleText: document.getElementById("themeToggleText"),
    startPauseButton: document.getElementById("startPauseButton"),
    resetButton: document.getElementById("resetButton"),
    skipButton: document.getElementById("skipButton"),
    cycleRow: document.querySelector(".session-row"),
    todayMetric: document.getElementById("todayMetric"),
    minutesMetric: document.getElementById("minutesMetric"),
    clearStatsButton: document.getElementById("clearStatsButton"),
    focusMinutes: document.getElementById("focusMinutes"),
    shortMinutes: document.getElementById("shortMinutes"),
    longMinutes: document.getElementById("longMinutes"),
    longEvery: document.getElementById("longEvery"),
    autoStartToggle: document.getElementById("autoStartToggle"),
    soundToggle: document.getElementById("soundToggle"),
    ambientLabel: document.getElementById("ambientLabel"),
    ambientManageButton: document.getElementById("ambientManageButton"),
    ambientOverlay: document.getElementById("ambientOverlay"),
    ambientCloseButton: document.getElementById("ambientCloseButton"),
    ambientLibrary: document.getElementById("ambientLibrary"),
    ambientToggleButton: document.getElementById("ambientToggleButton"),
    ambientVolume: document.getElementById("ambientVolume"),
    ambientVolumeValue: document.getElementById("ambientVolumeValue"),
    notifyButton: document.getElementById("notifyButton"),
    themeColorMeta: document.querySelector('meta[name="theme-color"]')
  };

  initialise();

  // Runs once after the deferred script loads and prepares the first render.
  function initialise() {
    applyRuntime();
    rollTodayIfNeeded();
    restoreRunningTimer();
    applyTheme();
    syncInputs();
    bindEvents();
    render();
    setTicking(state.isRunning);
  }

  function applyRuntime() {
    const params = new URLSearchParams(window.location.search);
    const isTauri = params.get("runtime") === "tauri" || Boolean(window.__TAURI_INTERNALS__ || window.__TAURI__);
    const isAndroid = isTauri && /android/i.test(navigator.userAgent);
    document.documentElement.dataset.runtime = isTauri ? (isAndroid ? "android" : "tauri") : "web";

    if (isTauri && !isAndroid) {
      document.querySelector(".traffic-lights")?.remove();
      bindTauriWindowDrag();
    }
  }

  function bindTauriWindowDrag() {
    const dragRegion = document.querySelector("[data-tauri-drag-region]");
    if (!dragRegion || dragRegion.dataset.dragBound === "true") {
      return;
    }

    dragRegion.dataset.dragBound = "true";
    dragRegion.addEventListener("mousedown", (event) => {
      if (event.button !== 0 || isInteractiveDragTarget(event.target)) {
        return;
      }

      startTauriWindowDrag();
    });
  }

  function isInteractiveDragTarget(target) {
    return Boolean(target?.closest("button, input, select, textarea, a, label, [role='button']"));
  }

  function startTauriWindowDrag() {
    try {
      const tauriWindow = window.__TAURI__?.window;
      const currentWindow = tauriWindow?.getCurrentWindow?.();
      const dragResult = currentWindow?.startDragging?.() || tauriWindow?.appWindow?.startDragging?.();

      if (dragResult && typeof dragResult.catch === "function") {
        dragResult.catch(() => {});
      }
    } catch {
      // The web version has no Tauri window API; this is intentionally a no-op.
    }
  }

  function listenAndroidBackButton() {
    if (document.documentElement.dataset.runtime !== "android") {
      return;
    }

    const tauriEvent = window.__TAURI__?.event;
    if (tauriEvent) {
      tauriEvent.listen("tauri://back-requested", (event) => {
        if (!elements.ambientOverlay.hidden) {
          closeAmbientDialog();
          event.preventDefault();
        }
      });
    }
  }

  // Connects UI controls, keyboard shortcuts, and browser events to app logic.
  function bindEvents() {
    elements.startPauseButton.addEventListener("click", toggleTimer);
    elements.resetButton.addEventListener("click", resetTimer);
    elements.skipButton.addEventListener("click", () => finishMode({ counted: false, automatic: false }));

    elements.modeTabs.forEach((button) => {
      button.addEventListener("click", () => switchMode(button.dataset.mode));
    });

    [
      elements.focusMinutes,
      elements.shortMinutes,
      elements.longMinutes,
      elements.longEvery
    ].forEach((input) => {
      input.addEventListener("change", () => updateNumberSetting(input));
      input.addEventListener("blur", () => updateNumberSetting(input));
    });

    elements.autoStartToggle.addEventListener("change", () => {
      state.settings.autoStart = elements.autoStartToggle.checked;
      saveState();
    });

    elements.soundToggle.addEventListener("change", () => {
      state.settings.sound = elements.soundToggle.checked;
      saveState();
    });

    elements.ambientManageButton.addEventListener("click", openAmbientDialog);
    elements.ambientCloseButton.addEventListener("click", closeAmbientDialog);
    elements.ambientOverlay.addEventListener("click", (event) => {
      if (event.target === elements.ambientOverlay) {
        closeAmbientDialog();
      }
    });
    elements.ambientToggleButton.addEventListener("click", toggleAmbientPlayback);
    elements.ambientVolume.addEventListener("input", updateAmbientVolume);

    elements.notifyButton.addEventListener("click", requestNotifications);
    elements.clearStatsButton.addEventListener("click", clearFocusStats);
    elements.themeToggleButton.addEventListener("click", toggleTheme);

    listenAndroidBackButton();

    document.addEventListener("visibilitychange", () => {
      if (!state.isRunning) {
        return;
      }

      if (secondsRemaining() <= 0) {
        finishMode({ counted: true, automatic: true });
        return;
      }

      render();
    });

    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && !elements.ambientOverlay.hidden) {
        closeAmbientDialog();
        return;
      }

      const tagName = event.target && event.target.tagName;
      const isTyping = tagName === "INPUT" || tagName === "TEXTAREA";

      if (isTyping) {
        return;
      }

      if (event.code === "Space") {
        event.preventDefault();
        toggleTimer();
      } else if (event.key.toLowerCase() === "r") {
        resetTimer();
      } else if (event.key.toLowerCase() === "s") {
        finishMode({ counted: false, automatic: false });
      } else if (event.key === "1") {
        switchMode("focus");
      } else if (event.key === "2") {
        switchMode("short");
      } else if (event.key === "3") {
        switchMode("long");
      }
    });

    window.addEventListener("beforeunload", () => {
      if (state.isRunning) {
        state.remaining = secondsRemaining();
      }
      saveState();
    });
  }

  // Reads saved state and merges it with defaults so newly added settings still
  // exist for users who already had older saved data.
  function loadState() {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
      if (!saved || typeof saved !== "object") {
        return cloneDefaults();
      }

      const merged = {
        ...cloneDefaults(),
        ...saved,
        settings: {
          ...defaults.settings,
          ...(saved.settings || {})
        }
      };

      if (!modes[merged.mode]) {
        merged.mode = defaults.mode;
      }

      normaliseLoadedState(merged);
      return merged;
    } catch {
      return cloneDefaults();
    }
  }

  // Make a deep copy so nested objects like settings are not shared by reference.
  function cloneDefaults() {
    return JSON.parse(JSON.stringify(defaults));
  }

  // localStorage can be edited or contain old/broken values, so clamp anything
  // user-facing before the app uses it.
  function normaliseLoadedState(nextState) {
    nextState.settings.focusMinutes = boundedInteger(nextState.settings.focusMinutes, 1, 180, defaults.settings.focusMinutes);
    nextState.settings.shortMinutes = boundedInteger(nextState.settings.shortMinutes, 1, 90, defaults.settings.shortMinutes);
    nextState.settings.longMinutes = boundedInteger(nextState.settings.longMinutes, 1, 120, defaults.settings.longMinutes);
    nextState.settings.longEvery = boundedInteger(nextState.settings.longEvery, 2, 12, defaults.settings.longEvery);
    nextState.completedInCycle = boundedInteger(nextState.completedInCycle, 0, nextState.settings.longEvery - 1, 0);
    nextState.todayFocusSessions = boundedInteger(nextState.todayFocusSessions, 0, 10000, 0);
    nextState.todayFocusMinutes = boundedInteger(nextState.todayFocusMinutes, 0, 100000, 0);
    nextState.settings.theme = nextState.settings.theme === "light" ? "light" : "dark";
    const savedAmbientSounds = Array.isArray(nextState.settings.ambientSounds)
      ? nextState.settings.ambientSounds
      : [];
    const legacyAmbientSounds = ambientSounds[nextState.settings.ambientSound] && nextState.settings.ambientSound !== "off"
      ? [nextState.settings.ambientSound]
      : defaults.settings.ambientSounds;
    const normalisedAmbientSounds = normaliseAmbientSoundKeys(savedAmbientSounds);
    setAmbientSelection(normalisedAmbientSounds.length ? normalisedAmbientSounds : legacyAmbientSounds, nextState);
    nextState.settings.ambientVolume = boundedInteger(nextState.settings.ambientVolume, 0, 100, defaults.settings.ambientVolume);
    nextState.settings.ambientSoundVolumes = normaliseAmbientSoundVolumes(nextState.settings.ambientSoundVolumes);

    if (!Number.isFinite(Number(nextState.currentDuration)) || Number(nextState.currentDuration) <= 0) {
      nextState.currentDuration = durationFor(nextState.mode, nextState.settings);
    }

    if (!Number.isFinite(Number(nextState.remaining)) || Number(nextState.remaining) < 0) {
      nextState.remaining = nextState.currentDuration;
    }
  }

  // Converts any input to a whole number within an allowed range.
  function boundedInteger(value, min, max, fallback) {
    const number = Math.round(Number(value));
    if (!Number.isFinite(number)) {
      return fallback;
    }
    return Math.min(max, Math.max(min, number));
  }

  function normaliseAmbientSoundKeys(soundKeys) {
    if (!Array.isArray(soundKeys)) {
      return [];
    }

    return Array.from(new Set(soundKeys.filter((soundKey) => ambientSounds[soundKey] && ambientSounds[soundKey].src)));
  }

  function normaliseAmbientSoundVolumes(soundVolumes) {
    const normalisedVolumes = {};
    const savedVolumes = soundVolumes && typeof soundVolumes === "object" ? soundVolumes : {};

    Object.keys(ambientSounds).forEach((soundKey) => {
      if (ambientSounds[soundKey].src) {
        normalisedVolumes[soundKey] = boundedInteger(savedVolumes[soundKey], 0, 100, 100);
      }
    });

    return normalisedVolumes;
  }

  function ambientSoundVolume(soundKey) {
    const savedVolumes = state.settings.ambientSoundVolumes || {};
    return boundedInteger(savedVolumes[soundKey], 0, 100, 100);
  }

  function setAmbientSoundVolume(soundKey, value) {
    if (!state.settings.ambientSoundVolumes || typeof state.settings.ambientSoundVolumes !== "object") {
      state.settings.ambientSoundVolumes = normaliseAmbientSoundVolumes({});
    }

    state.settings.ambientSoundVolumes[soundKey] = boundedInteger(value, 0, 100, 100);
  }

  function selectedAmbientSoundKeys() {
    return normaliseAmbientSoundKeys(state.settings.ambientSounds);
  }

  function setAmbientSelection(soundKeys, targetState = state) {
    targetState.settings.ambientSounds = normaliseAmbientSoundKeys(soundKeys);
    targetState.settings.ambientSound = targetState.settings.ambientSounds[0] || "off";
  }

  // Persist the full app state after each meaningful change.
  function saveState() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }

  // Daily stats reset automatically when the calendar day changes.
  function rollTodayIfNeeded() {
    const currentKey = todayKey();
    if (state.todayKey !== currentKey) {
      state.todayKey = currentKey;
      state.todayFocusSessions = 0;
      state.todayFocusMinutes = 0;
      saveState();
    }
  }

  // Rebuild a running timer after reload by comparing the saved end time with
  // the current clock. This keeps timing accurate even if the tab was closed.
  function restoreRunningTimer() {
    if (!state.isRunning || !state.endAt) {
      state.isRunning = false;
      state.endAt = null;
      state.currentDuration = state.currentDuration || modeDuration(state.mode);
      state.remaining = clampRemaining(state.remaining);
      return;
    }

    const remaining = Math.ceil((state.endAt - Date.now()) / 1000);
    if (remaining > 0) {
      state.remaining = remaining;
      return;
    }

    state.isRunning = false;
    state.endAt = null;
    state.remaining = 0;
    state.currentDuration = state.currentDuration || modeDuration(state.mode);
  }

  // Push saved state into form controls before the user starts interacting.
  function syncInputs() {
    elements.focusMinutes.value = state.settings.focusMinutes;
    elements.shortMinutes.value = state.settings.shortMinutes;
    elements.longMinutes.value = state.settings.longMinutes;
    elements.longEvery.value = state.settings.longEvery;
    elements.autoStartToggle.checked = state.settings.autoStart;
    elements.soundToggle.checked = state.settings.sound;
    elements.ambientVolume.value = state.settings.ambientVolume;
    elements.ambientVolumeValue.textContent = `${state.settings.ambientVolume}%`;
    updateNotificationButton();
    updateThemeButton();
  }

  function scheduleTimerNotification() {
    if (!isTauriAndroid()) {
      return;
    }

    const bridge = window.TimerBridge;
    if (!bridge) {
      return;
    }

    try {
      const nextMode = modeAfter(state.mode);
      const nextDuration = modeDuration(nextMode);
      const autoStart = Boolean(state.settings.autoStart);
      const focusEndAt = state.endAt;
      const nextStartAt = focusEndAt + 700;
      const nextEndAt = nextStartAt + nextDuration * 1000;

      bridge.timerStart(
        state.endAt,
        state.currentDuration,
        modes[state.mode].label,
        autoStart,
        nextEndAt,
        nextDuration,
        modes[nextMode].label
      );
    } catch {
      // bridge not available
    }
  }

  function modeAfter(mode) {
    if (mode === "focus") {
      const nextCycle = (state.completedInCycle + 1) % state.settings.longEvery;
      return nextCycle === 0 ? "long" : "short";
    }
    return "focus";
  }

  function stopTimerNotification() {
    if (!isTauriAndroid()) {
      return;
    }

    try {
      window.TimerBridge?.timerStop();
    } catch {
      // bridge not available
    }
  }

  function clearAutoStart() {
    if (autoStartHandle !== null) {
      window.clearTimeout(autoStartHandle);
      autoStartHandle = null;
    }
  }

  function toggleTimer() {
    if (state.isRunning) {
      pauseTimer();
    } else {
      startTimer();
    }
  }

  // Starts the current mode and stores an absolute end timestamp for accuracy.
  function startTimer() {
    if (state.remaining <= 0) {
      state.currentDuration = modeDuration(state.mode);
      state.remaining = state.currentDuration;
    }

    state.currentDuration = state.currentDuration || modeDuration(state.mode);
    unlockAudio();
    startAmbientSounds();
    state.isRunning = true;
    state.endAt = Date.now() + state.remaining * 1000;
    setTicking(true);
    requestWakeLock();
    scheduleTimerNotification();
    saveState();
    render();
  }

  // Pauses by converting the absolute end time back into remaining seconds.
  function pauseTimer() {
    clearAutoStart();
    state.remaining = secondsRemaining();
    state.isRunning = false;
    state.endAt = null;
    setTicking(false);
    releaseWakeLock();
    stopTimerNotification();
    saveState();
    render();
  }

  // Resets the current mode to its configured duration without changing modes.
  function resetTimer() {
    clearAutoStart();
    state.isRunning = false;
    state.endAt = null;
    state.currentDuration = modeDuration(state.mode);
    state.remaining = state.currentDuration;
    setTicking(false);
    releaseWakeLock();
    stopTimerNotification();
    saveState();
    render();
  }

  // Manual mode changes stop the timer and load that mode's full duration.
  function switchMode(nextMode) {
    if (!modes[nextMode] || nextMode === state.mode) {
      return;
    }

    clearAutoStart();
    state.mode = nextMode;
    state.isRunning = false;
    state.endAt = null;
    state.currentDuration = modeDuration(nextMode);
    state.remaining = state.currentDuration;
    setTicking(false);
    releaseWakeLock();
    stopTimerNotification();
    saveState();
    render();
  }

  // Shared completion flow for real timer endings and manual skips.
  // counted controls whether focus stats increase; automatic controls alerts.
  function finishMode({ counted, automatic }) {
    clearAutoStart();
    const completedMode = state.mode;
    const shouldCountFocus = counted && completedMode === "focus";

    if (shouldCountFocus) {
      rollTodayIfNeeded();
      state.completedInCycle = (state.completedInCycle + 1) % state.settings.longEvery;
      state.todayFocusSessions += 1;
      state.todayFocusMinutes += Math.round((state.currentDuration || modeDuration("focus")) / 60);
    }

    const nextMode = getNextMode(completedMode, shouldCountFocus);
    state.mode = nextMode;
    state.currentDuration = modeDuration(nextMode);
    state.remaining = state.currentDuration;
    state.isRunning = false;
    state.endAt = null;
    setTicking(false);
    releaseWakeLock();
    stopTimerNotification();
    saveState();
    render();

    if (automatic) {
      announceCompletion(completedMode);
    }

    if (automatic && state.settings.autoStart) {
      autoStartHandle = window.setTimeout(startTimer, 700);
    }
  }

  // Decide whether the next session should be focus, short break, or long break.
  function getNextMode(completedMode, countedFocus) {
    if (completedMode !== "focus") {
      return "focus";
    }

    if (!countedFocus) {
      return state.completedInCycle === state.settings.longEvery - 1 ? "long" : "short";
    }

    return state.completedInCycle === 0 ? "long" : "short";
  }

  // setInterval only drives UI updates. The real remaining time is calculated
  // from Date.now(), which is more reliable when a browser throttles timers.
  function setTicking(shouldTick) {
    window.clearInterval(tickHandle);
    tickHandle = null;

    if (!shouldTick) {
      return;
    }

    tickHandle = window.setInterval(() => {
      const remaining = secondsRemaining();
      state.remaining = remaining;

      if (remaining <= 0) {
        finishMode({ counted: true, automatic: true });
        return;
      }

      render();
    }, 1000);
  }

  // Calculate remaining time from the saved end timestamp when running.
  function secondsRemaining() {
    if (!state.isRunning || !state.endAt) {
      return clampRemaining(state.remaining);
    }

    return Math.max(0, Math.ceil((state.endAt - Date.now()) / 1000));
  }

  // Look up the duration for a mode using the current settings.
  function modeDuration(mode) {
    return durationFor(mode, state.settings);
  }

  // Convert a mode's minutes setting into seconds.
  function durationFor(mode, settings) {
    return Math.round(Number(settings[modes[mode].durationKey]) * 60);
  }

  // Keep remaining seconds usable if loaded state or form input is invalid.
  function clampRemaining(value) {
    const number = Number(value);
    if (!Number.isFinite(number) || number < 0) {
      return modeDuration(state.mode);
    }
    return Math.round(number);
  }

  // Validate a numeric setting, save it, and update the visible timer if needed.
  function updateNumberSetting(input) {
    const min = Number(input.min || 1);
    const max = Number(input.max || 180);
    const value = Math.min(max, Math.max(min, Math.round(Number(input.value) || min)));
    input.value = value;
    state.settings[input.id] = value;

    if (input.id === "longEvery") {
      state.completedInCycle = Math.min(state.completedInCycle, value - 1);
    }

    if (!state.isRunning && modes[state.mode].durationKey === input.id) {
      state.currentDuration = modeDuration(state.mode);
      state.remaining = state.currentDuration;
    }

    saveState();
    render();
  }

  // Clear today's focus counters and reset the cycle position.
  function clearFocusStats() {
    rollTodayIfNeeded();
    state.todayFocusSessions = 0;
    state.todayFocusMinutes = 0;
    state.completedInCycle = 0;
    saveState();
    render();
    setTransientStatus("Stats cleared");
  }

  function openAmbientDialog() {
    lastAmbientTrigger = document.activeElement;
    elements.ambientOverlay.hidden = false;
    elements.body.classList.add("ambient-open");
    renderAmbientControls();
    elements.ambientCloseButton.focus();
  }

  function closeAmbientDialog() {
    elements.ambientOverlay.hidden = true;
    elements.body.classList.remove("ambient-open");

    if (lastAmbientTrigger && typeof lastAmbientTrigger.focus === "function") {
      lastAmbientTrigger.focus();
    }
  }

  // Toggle ambient tracks. Choosing a rain option starts playback immediately
  // because the click is a trusted browser audio gesture.
  async function chooseAmbientSound(soundKey) {
    if (!ambientSounds[soundKey]) {
      return;
    }

    if (soundKey === "off") {
      setAmbientSelection([]);
      stopAmbientSounds({ remove: true });
      saveState();
      render();
      return;
    } else {
      const selectedSoundKeys = selectedAmbientSoundKeys();
      const isSelected = selectedSoundKeys.includes(soundKey);
      const nextSoundKeys = isSelected
        ? selectedSoundKeys.filter((selectedSoundKey) => selectedSoundKey !== soundKey)
        : [...selectedSoundKeys, soundKey];

      setAmbientSelection(nextSoundKeys);

      if (isSelected) {
        stopAmbientTrack(soundKey, { remove: true });
      } else {
        saveState();
        render();
        const started = await startAmbientTrack(soundKey);
        if (!started && selectedAmbientSoundKeys().includes(soundKey)) {
          setTransientStatus("Sound blocked");
        }
      }
    }

    saveState();
    render();
  }

  // Ambient Sounds can run independently from the timer.
  async function toggleAmbientPlayback() {
    if (!selectedAmbientSoundKeys().length) {
      return;
    }

    if (ambientIsPlaying() || ambientIsPending()) {
      stopAmbientSounds();
    } else {
      await startAmbientSounds();
    }

    render();
  }

  // Store volume as a percentage so it survives reloads cleanly.
  function updateAmbientVolume() {
    state.settings.ambientVolume = boundedInteger(elements.ambientVolume.value, 0, 100, defaults.settings.ambientVolume);
    elements.ambientVolume.value = state.settings.ambientVolume;
    elements.ambientVolumeValue.textContent = `${state.settings.ambientVolume}%`;
    applyAmbientVolume();
    saveState();
  }

  function updateAmbientSoundVolume(soundKey, input, valueLabel) {
    if (!ambientSounds[soundKey] || !ambientSounds[soundKey].src) {
      return;
    }

    setAmbientSoundVolume(soundKey, input.value);
    input.value = ambientSoundVolume(soundKey);
    valueLabel.textContent = `${ambientSoundVolume(soundKey)}%`;
    applyAmbientVolume();
    saveState();
  }

  // Each selected ambience owns two audio elements so tracks can layer while
  // still crossfading smoothly at their individual loop points.
  async function startAmbientSounds() {
    const soundKeys = selectedAmbientSoundKeys();
    if (!soundKeys.length) {
      stopAmbientSounds();
      return;
    }

    const results = await Promise.all(soundKeys.map((soundKey) => startAmbientTrack(soundKey)));
    if (results.some((started) => !started)) {
      setTransientStatus("Sound blocked");
    }
    renderAmbientControls();
  }

  async function startAmbientTrack(soundKey) {
    const track = prepareAmbientTrack(soundKey);
    if (!track) {
      return false;
    }

    if (track.isPlaying || track.isPending) {
      applyAmbientTrackVolume(track);
      return true;
    }

    const activePlayer = track.players[track.activeIndex];
    const playToken = track.playToken + 1;
    track.playToken = playToken;
    track.isPending = true;
    activePlayer.loop = false;
    activePlayer.currentTime = 0;
    activePlayer.volume = targetAmbientVolume(soundKey);

    try {
      await activePlayer.play();
      if (track.playToken !== playToken || !selectedAmbientSoundKeys().includes(soundKey)) {
        activePlayer.pause();
        activePlayer.currentTime = 0;
        activePlayer.volume = 0;
        return false;
      }

      track.isPlaying = true;
      startAmbientLoopMonitor(track);
      return true;
    } catch {
      track.isPlaying = false;
      return false;
    } finally {
      track.isPending = false;
      renderAmbientControls();
    }
  }

  function stopAmbientSounds({ remove = false } = {}) {
    Object.keys(ambientState.tracks).forEach((soundKey) => {
      stopAmbientTrack(soundKey, { remove });
    });

    renderAmbientControls();
  }

  function stopAmbientTrack(soundKey, { remove = false } = {}) {
    const track = ambientState.tracks[soundKey];
    if (!track) {
      return;
    }

    window.clearInterval(track.loopHandle);
    window.clearInterval(track.fadeHandle);
    track.loopHandle = null;
    track.fadeHandle = null;
    track.playToken += 1;
    track.isPlaying = false;
    track.isPending = false;
    track.isCrossfading = false;

    track.players.forEach((player) => {
      player.pause();
      player.currentTime = 0;
      player.loop = false;
      player.volume = 0;
    });

    if (remove) {
      delete ambientState.tracks[soundKey];
    }
  }

  function prepareAmbientTrack(soundKey) {
    const sound = ambientSounds[soundKey];
    if (!sound || !sound.src) {
      return null;
    }

    const existingTrack = ambientState.tracks[soundKey];
    if (existingTrack && existingTrack.players.length === 2) {
      return existingTrack;
    }

    if (existingTrack) {
      stopAmbientTrack(soundKey, { remove: true });
    }

    ambientState.tracks[soundKey] = createAmbientTrack(soundKey, sound.src);
    return ambientState.tracks[soundKey];
  }

  function createAmbientTrack(soundKey, src) {
    return {
      soundKey,
      players: [createAmbientPlayer(src), createAmbientPlayer(src)],
      activeIndex: 0,
      lastStartTime: 0,
      loopHandle: null,
      fadeHandle: null,
      isPlaying: false,
      isPending: false,
      isCrossfading: false,
      playToken: 0
    };
  }

  function createAmbientPlayer(src) {
    const player = new Audio(src);
    player.preload = "auto";
    player.loop = false;
    player.volume = 0;
    return player;
  }

  function startAmbientLoopMonitor(track) {
    window.clearInterval(track.loopHandle);
    track.loopHandle = window.setInterval(() => checkAmbientLoop(track), AMBIENT_LOOP_POLL_MS);
  }

  function checkAmbientLoop(track) {
    if (!track.isPlaying || track.isCrossfading) {
      return;
    }

    const activePlayer = track.players[track.activeIndex];
    if (!activePlayer || !Number.isFinite(activePlayer.duration) || activePlayer.duration <= 0) {
      return;
    }
    activePlayer.loop = false;

    const fadeSeconds = ambientCrossfadeSeconds(activePlayer.duration);
    const edgeGuardSeconds = ambientLoopEdgeGuardSeconds(activePlayer.duration);
    if (activePlayer.duration - activePlayer.currentTime <= fadeSeconds + edgeGuardSeconds) {
      crossfadeAmbientPlayers(track, fadeSeconds);
    }
  }

  async function crossfadeAmbientPlayers(track, fadeSeconds) {
    const fromPlayer = track.players[track.activeIndex];
    const nextIndex = track.activeIndex === 0 ? 1 : 0;
    const toPlayer = track.players[nextIndex];
    const fadeToken = track.playToken;

    if (!fromPlayer || !toPlayer) {
      return;
    }

    track.isCrossfading = true;
    fromPlayer.loop = false;
    toPlayer.loop = false;
    toPlayer.pause();
    setAmbientPlayerTime(toPlayer, ambientLoopStartTime(track, fromPlayer.duration));
    toPlayer.volume = 0;

    try {
      await toPlayer.play();
      if (track.playToken !== fadeToken || !selectedAmbientSoundKeys().includes(track.soundKey)) {
        toPlayer.pause();
        toPlayer.currentTime = 0;
        toPlayer.volume = 0;
        track.isCrossfading = false;
        return;
      }
    } catch {
      fromPlayer.loop = true;
      track.isCrossfading = false;
      return;
    }

    const startedAt = window.performance.now();
    window.clearInterval(track.fadeHandle);
    track.fadeHandle = window.setInterval(() => {
      const elapsed = (window.performance.now() - startedAt) / 1000;
      const progress = Math.min(1, elapsed / fadeSeconds);
      const fadeOut = Math.cos(progress * Math.PI * 0.5);
      const fadeIn = Math.sin(progress * Math.PI * 0.5);
      const targetVolume = targetAmbientVolume(track.soundKey);

      fromPlayer.volume = targetVolume * fadeOut;
      toPlayer.volume = targetVolume * fadeIn;

      if (progress >= 1) {
        window.clearInterval(track.fadeHandle);
        track.fadeHandle = null;
        fromPlayer.pause();
        fromPlayer.currentTime = 0;
        fromPlayer.volume = 0;
        toPlayer.volume = targetVolume;
        track.activeIndex = nextIndex;
        track.isCrossfading = false;
      }
    }, 40);
  }

  function ambientCrossfadeSeconds(duration) {
    if (!Number.isFinite(duration) || duration <= 0) {
      return AMBIENT_CROSSFADE_SECONDS;
    }

    return Math.min(AMBIENT_CROSSFADE_SECONDS, Math.max(1.2, duration * 0.18));
  }

  function ambientLoopEdgeGuardSeconds(duration) {
    if (!Number.isFinite(duration) || duration <= AMBIENT_LOOP_EDGE_GUARD_SECONDS * 4) {
      return 0;
    }

    return Math.min(AMBIENT_LOOP_EDGE_GUARD_SECONDS, duration * 0.04);
  }

  function ambientLoopStartTime(track, duration) {
    const edgeGuardSeconds = ambientLoopEdgeGuardSeconds(duration);
    const fadeSeconds = ambientCrossfadeSeconds(duration);

    if (!Number.isFinite(duration) || duration <= edgeGuardSeconds + fadeSeconds + 6) {
      track.lastStartTime = 0;
      return 0;
    }

    const earliestStart = edgeGuardSeconds;
    const latestStart = Math.max(earliestStart, duration - edgeGuardSeconds - fadeSeconds - 10);
    const startRange = latestStart - earliestStart;

    if (startRange <= 0.5) {
      track.lastStartTime = earliestStart;
      return earliestStart;
    }

    let startTime = earliestStart + Math.random() * startRange;

    if (startRange > 16 && Math.abs(startTime - track.lastStartTime) < 8) {
      startTime = earliestStart + ((startTime - earliestStart + startRange * 0.5) % startRange);
    }

    track.lastStartTime = startTime;
    return startTime;
  }

  function setAmbientPlayerTime(player, seconds) {
    try {
      player.currentTime = seconds;
    } catch {
      player.currentTime = 0;
    }
  }

  function applyAmbientVolume() {
    ambientTracks().forEach(applyAmbientTrackVolume);
  }

  function applyAmbientTrackVolume(track) {
    const targetVolume = targetAmbientVolume(track.soundKey);
    track.players.forEach((player, index) => {
      if (!player.paused && !track.isCrossfading) {
        player.volume = index === track.activeIndex ? targetVolume : 0;
      }
    });
  }

  function ambientTracks() {
    return Object.values(ambientState.tracks);
  }

  function ambientIsPlaying() {
    return ambientTracks().some((track) => track.isPlaying);
  }

  function ambientIsPending() {
    return ambientTracks().some((track) => track.isPending);
  }

  function targetAmbientVolume(soundKey) {
    const globalVolume = Math.min(1, Math.max(0, state.settings.ambientVolume / 100));
    const soundVolume = ambientSounds[soundKey] && ambientSounds[soundKey].src
      ? ambientSoundVolume(soundKey) / 100
      : 1;
    return Math.min(1, Math.max(0, globalVolume * soundVolume));
  }

  // Flip between dark and light themes, then persist the choice.
  function toggleTheme() {
    state.settings.theme = state.settings.theme === "light" ? "dark" : "light";
    applyTheme();
    updateThemeButton();
    saveState();
  }

  // Apply the theme to the document so CSS variables can update the whole UI.
  function applyTheme() {
    const theme = state.settings.theme === "light" ? "light" : "dark";
    state.settings.theme = theme;
    document.documentElement.dataset.theme = theme;

    if (elements.themeColorMeta) {
      elements.themeColorMeta.setAttribute("content", theme === "light" ? "#f4f6fb" : "#08090c");
    }
  }

  // The button label shows the theme the user can switch to next.
  function updateThemeButton() {
    const isLight = state.settings.theme === "light";
    const nextTheme = isLight ? "dark" : "light";
    const label = `Switch to ${nextTheme} theme`;
    elements.themeToggleText.textContent = isLight ? "Dark" : "Light";
    elements.themeToggleButton.setAttribute("aria-label", label);
    elements.themeToggleButton.title = label;
  }

  function isTauriAndroid() {
    return document.documentElement.dataset.runtime === "android";
  }

  function tauriNotify() {
    return window.__TAURI__?.core?.invoke;
  }

  // Ask for notification permission and store the user's choice.
  async function requestNotifications() {
    if (isTauriAndroid()) {
      try {
        const invoke = tauriNotify();
        const permission = await invoke("plugin:notification|request_permission");
        state.settings.notifications = permission;
        setTransientStatus(permission ? "Notifications on" : "Notifications off");
        saveState();
        updateNotificationButton();
        return;
      } catch {
        setTransientStatus("Notifications off");
        return;
      }
    }

    if (!("Notification" in window)) {
      setTransientStatus("Unsupported");
      state.settings.notifications = false;
      saveState();
      updateNotificationButton();
      return;
    }

    try {
      const permissionResult = Notification.requestPermission();
      const permission = permissionResult && typeof permissionResult.then === "function"
        ? await permissionResult
        : Notification.permission;
      state.settings.notifications = permission === "granted";
      setTransientStatus(permission === "granted" ? "Notifications on" : "Notifications off");
      saveState();
      updateNotificationButton();
    } catch {
      setTransientStatus("Notifications off");
    }
  }

  // Keep the notification button honest about browser support and permission.
  function updateNotificationButton() {
    if (isTauriAndroid()) {
      elements.notifyButton.disabled = false;
      elements.notifyButton.textContent = state.settings.notifications
        ? "Notifications enabled"
        : "Enable notifications";
      return;
    }

    if (!("Notification" in window)) {
      elements.notifyButton.textContent = "Notifications unavailable";
      elements.notifyButton.disabled = true;
      return;
    }

    if (Notification.permission === "granted" && state.settings.notifications) {
      elements.notifyButton.textContent = "Notifications enabled";
    } else if (Notification.permission === "denied") {
      elements.notifyButton.textContent = "Notifications blocked";
    } else {
      elements.notifyButton.textContent = "Enable notifications";
    }
  }

  // Runs the completion feedback: sound first, then optional notification.
  function announceCompletion(completedMode) {
    const mode = modes[completedMode];

    if (state.settings.sound) {
      playChime(completedMode);
    }

    if (!state.settings.notifications) {
      return;
    }

    if (isTauriAndroid()) {
      try {
        const invoke = tauriNotify();
        invoke("plugin:notification|notify", {
          title: mode.completeTitle,
          body: mode.completeMessage,
          icon: "assets/app-icon.svg"
        }).catch(function () {});
      } catch {
        // silently fail
      }
      return;
    }

    if ("Notification" in window && Notification.permission === "granted") {
      new Notification(mode.completeTitle, {
        body: mode.completeMessage,
        icon: "assets/app-icon.svg",
        badge: "assets/app-icon.svg"
      });
    }
  }

  // Browsers only allow audio after user interaction, so create the AudioContext
  // when the user starts the timer instead of waiting until the session ends.
  function unlockAudio() {
    if (!state.settings.sound || audioContext) {
      return;
    }

    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (!AudioContext) {
      return;
    }

    audioContext = new AudioContext();
    if (audioContext.state === "suspended") {
      audioContext.resume();
    }
  }

  // Play different note patterns for finished focus sessions and finished breaks.
  function playChime(completedMode) {
    unlockAudio();
    if (!audioContext) {
      return;
    }

    const now = audioContext.currentTime;
    const pattern = completedMode === "focus"
      ? {
          type: "triangle",
          volume: 0.26,
          notes: [
            { frequency: 523.25, time: 0, length: 0.22 },
            { frequency: 659.25, time: 0.16, length: 0.22 },
            { frequency: 783.99, time: 0.32, length: 0.28 },
            { frequency: 1046.5, time: 0.58, length: 0.36 }
          ]
        }
      : {
          type: "square",
          volume: 0.18,
          notes: [
            { frequency: 880, time: 0, length: 0.15 },
            { frequency: 880, time: 0.22, length: 0.15 },
            { frequency: 659.25, time: 0.48, length: 0.28 }
          ]
        };

    // Each note gets its own gain envelope so the sound is clear but not clipped.
    pattern.notes.forEach(({ frequency, time, length }) => {
      const start = now + time;
      const oscillator = audioContext.createOscillator();
      const gain = audioContext.createGain();
      oscillator.type = pattern.type;
      oscillator.frequency.setValueAtTime(frequency, start);
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(pattern.volume, start + 0.018);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + length);
      oscillator.connect(gain);
      gain.connect(audioContext.destination);
      oscillator.start(start);
      oscillator.stop(start + length + 0.04);
    });
  }

  // Ask supported browsers to keep the screen awake while the timer is running.
  async function requestWakeLock() {
    if (!("wakeLock" in navigator)) {
      return;
    }

    try {
      wakeLock = await navigator.wakeLock.request("screen");
      wakeLock.addEventListener("release", () => {
        wakeLock = null;
      });
    } catch {
      wakeLock = null;
    }
  }

  // Release the wake lock whenever the timer stops.
  async function releaseWakeLock() {
    if (!wakeLock) {
      return;
    }

    try {
      await wakeLock.release();
    } catch {
      wakeLock = null;
    }
  }

  // Show a short status message, then return to the normal Ready/Running label.
  function setTransientStatus(message) {
    elements.statusText.textContent = message;
    window.setTimeout(renderStatus, 1400);
  }

  // The single render function keeps the DOM in sync with state.
  function render() {
    rollTodayIfNeeded();
    const remaining = secondsRemaining();
    const duration = state.currentDuration || modeDuration(state.mode);
    const elapsed = Math.max(0, duration - remaining);
    const progress = duration > 0 ? Math.min(1, elapsed / duration) : 0;
    const mode = modes[state.mode];

    elements.body.dataset.mode = state.mode;
    elements.body.classList.toggle("is-running", state.isRunning);
    document.documentElement.style.setProperty("--progress", progress.toFixed(4));
    document.title = `${formatTime(remaining)} - ${mode.label}`;

    elements.modeLabel.textContent = mode.label;
    elements.timerTime.textContent = formatTime(remaining);
    elements.nextLabel.textContent = `Next: ${nextModeLabel()}`;
    elements.startPauseButton.textContent = state.isRunning ? "Pause" : "Start";

    elements.modeTabs.forEach((button) => {
      const isActive = button.dataset.mode === state.mode;
      button.classList.toggle("is-active", isActive);
      button.setAttribute("aria-selected", String(isActive));
    });

    renderCycleDots();
    Array.from(elements.cycleRow.children).forEach((dot, index) => {
      dot.classList.toggle("is-done", index < state.completedInCycle);
      dot.classList.toggle("is-current", index === state.completedInCycle);
    });

    elements.todayMetric.textContent = pluralise(state.todayFocusSessions, "focus session");
    elements.minutesMetric.textContent = `${state.todayFocusMinutes} min`;
    elements.clearStatsButton.disabled = state.todayFocusSessions === 0 && state.todayFocusMinutes === 0 && state.completedInCycle === 0;
    renderAmbientControls();
    renderStatus();
  }

  function renderAmbientControls() {
    const selectedSoundKeys = selectedAmbientSoundKeys();
    const isOff = selectedSoundKeys.length === 0;
    const isPlaying = ambientIsPlaying();
    const isPending = ambientIsPending();

    elements.ambientLabel.textContent = ambientLabelForSelection(selectedSoundKeys, isPlaying);
    elements.ambientVolume.value = state.settings.ambientVolume;
    elements.ambientVolumeValue.textContent = `${state.settings.ambientVolume}%`;
    elements.ambientVolume.disabled = isOff;
    elements.ambientToggleButton.disabled = isOff;
    elements.ambientToggleButton.textContent = isPending
      ? "Loading"
      : isPlaying
        ? "Stop"
        : "Play";
    elements.ambientToggleButton.setAttribute("aria-pressed", String(isPlaying));

    renderAmbientLibrary(selectedSoundKeys);
  }

  function renderAmbientLibrary(selectedSoundKeys) {
    const fragment = document.createDocumentFragment();

    Object.entries(ambientSounds)
      .forEach(([soundKey, sound]) => {
        const card = document.createElement("div");
        const selectButton = document.createElement("button");
        const isSelected = soundKey === "off"
          ? selectedSoundKeys.length === 0
          : selectedSoundKeys.includes(soundKey);
        card.className = "ambient-sound-card";
        card.dataset.sound = soundKey;
        card.classList.toggle("is-active", isSelected);
        selectButton.className = "ambient-sound-select";
        selectButton.type = "button";
        selectButton.setAttribute("role", "checkbox");
        selectButton.setAttribute("aria-checked", String(isSelected));

        const copy = document.createElement("span");
        copy.className = "ambient-sound-copy";

        const label = document.createElement("span");
        label.textContent = sound.label;

        const tone = document.createElement("small");
        tone.textContent = sound.tone;

        copy.append(label, tone);
        selectButton.appendChild(copy);
        selectButton.addEventListener("click", () => chooseAmbientSound(soundKey));
        card.appendChild(selectButton);

        if (sound.src) {
          const volumeControl = document.createElement("label");
          volumeControl.className = "ambient-sound-volume";

          const volumeText = document.createElement("span");
          const volumeValue = document.createElement("strong");
          volumeValue.textContent = `${ambientSoundVolume(soundKey)}%`;
          volumeText.append("Volume ", volumeValue);

          const volumeInput = document.createElement("input");
          volumeInput.type = "range";
          volumeInput.min = "0";
          volumeInput.max = "100";
          volumeInput.step = "1";
          volumeInput.value = ambientSoundVolume(soundKey);
          volumeInput.setAttribute("aria-label", `${sound.label} volume`);
          volumeInput.addEventListener("input", () => updateAmbientSoundVolume(soundKey, volumeInput, volumeValue));

          volumeControl.append(volumeText, volumeInput);
          card.appendChild(volumeControl);
        }

        fragment.appendChild(card);
      });

    elements.ambientLibrary.replaceChildren(fragment);
  }

  function ambientLabelForSelection(soundKeys, isPlaying) {
    if (!soundKeys.length) {
      return "Off";
    }

    const labels = soundKeys.map((soundKey) => ambientSounds[soundKey].label);
    const label = labels.length <= 2
      ? labels.join(" + ")
      : `${labels.length} sounds`;

    return isPlaying ? `${label} playing` : label;
  }

  // Rebuild cycle dots only when the long-break cadence changes.
  function renderCycleDots() {
    const needed = state.settings.longEvery;
    if (elements.cycleRow.children.length === needed) {
      return;
    }

    const fragment = document.createDocumentFragment();
    for (let index = 0; index < needed; index += 1) {
      const dot = document.createElement("span");
      dot.className = "cycle-dot";
      fragment.appendChild(dot);
    }
    elements.cycleRow.replaceChildren(fragment);
  }

  // Normal status text depends only on whether the timer is active.
  function renderStatus() {
    elements.statusText.textContent = state.isRunning ? "Running" : "Ready";
  }

  // Preview the mode that will come after the current one.
  function nextModeLabel() {
    if (state.mode !== "focus") {
      return "focus";
    }

    return state.completedInCycle === state.settings.longEvery - 1 ? "long break" : "short break";
  }

  // Format seconds as MM:SS for the timer and document title.
  function formatTime(totalSeconds) {
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }

  // Small helper for labels like "1 focus session" vs "2 focus sessions".
  function pluralise(count, noun) {
    return `${count} ${noun}${count === 1 ? "" : "s"}`;
  }

  // YYYY-MM-DD key used to decide when daily stats should reset.
  function todayKey() {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  }
})();
