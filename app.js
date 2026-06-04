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

  const ambientCategories = {
    focus: {
      label: "Focus"
    },
    calm: {
      label: "Calm"
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
      ambientVolume: 42
    }
  };

  const AMBIENT_CROSSFADE_SECONDS = 2.4;

  // Runtime state that changes while the page is open.
  let state = loadState();
  let tickHandle = null;
  let audioContext = null;
  let wakeLock = null;
  let activeAmbientCategory = "focus";
  let lastAmbientTrigger = null;
  let ambientState = {
    soundKey: "off",
    players: [],
    activeIndex: 0,
    loopHandle: null,
    fadeHandle: null,
    isPlaying: false,
    isPending: false,
    isCrossfading: false
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
    ambientCategoryTabs: Array.from(document.querySelectorAll(".ambient-tab")),
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
    rollTodayIfNeeded();
    restoreRunningTimer();
    applyTheme();
    syncInputs();
    bindEvents();
    render();
    setTicking(state.isRunning);
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
    elements.ambientCategoryTabs.forEach((button) => {
      button.addEventListener("click", () => switchAmbientCategory(button.dataset.category));
    });
    elements.ambientToggleButton.addEventListener("click", toggleAmbientPlayback);
    elements.ambientVolume.addEventListener("input", updateAmbientVolume);

    elements.notifyButton.addEventListener("click", requestNotifications);
    elements.clearStatsButton.addEventListener("click", clearFocusStats);
    elements.themeToggleButton.addEventListener("click", toggleTheme);

    document.addEventListener("visibilitychange", () => {
      if (state.isRunning) {
        render();
      }
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
    nextState.settings.ambientSound = ambientSounds[nextState.settings.ambientSound]
      ? nextState.settings.ambientSound
      : defaults.settings.ambientSound;
    nextState.settings.ambientVolume = boundedInteger(nextState.settings.ambientVolume, 0, 100, defaults.settings.ambientVolume);

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
      state.remaining = clampRemaining(state.remaining || modeDuration(state.mode));
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

  // The main Start/Pause button delegates to the right timer action.
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
    startAmbientSound();
    state.isRunning = true;
    state.endAt = Date.now() + state.remaining * 1000;
    setTicking(true);
    requestWakeLock();
    saveState();
    render();
  }

  // Pauses by converting the absolute end time back into remaining seconds.
  function pauseTimer() {
    state.remaining = secondsRemaining();
    state.isRunning = false;
    state.endAt = null;
    setTicking(false);
    releaseWakeLock();
    saveState();
    render();
  }

  // Resets the current mode to its configured duration without changing modes.
  function resetTimer() {
    state.isRunning = false;
    state.endAt = null;
    state.currentDuration = modeDuration(state.mode);
    state.remaining = state.currentDuration;
    setTicking(false);
    releaseWakeLock();
    saveState();
    render();
  }

  // Manual mode changes stop the timer and load that mode's full duration.
  function switchMode(nextMode) {
    if (!modes[nextMode] || nextMode === state.mode) {
      return;
    }

    state.mode = nextMode;
    state.isRunning = false;
    state.endAt = null;
    state.currentDuration = modeDuration(nextMode);
    state.remaining = state.currentDuration;
    setTicking(false);
    releaseWakeLock();
    saveState();
    render();
  }

  // Shared completion flow for real timer endings and manual skips.
  // counted controls whether focus stats increase; automatic controls alerts.
  function finishMode({ counted, automatic }) {
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
    saveState();
    render();

    if (automatic) {
      announceCompletion(completedMode);
    }

    if (automatic && state.settings.autoStart) {
      window.setTimeout(startTimer, 700);
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
    }, 250);
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

  // Clear only today's focus counters; timer and preferences stay intact.
  function clearFocusStats() {
    rollTodayIfNeeded();
    state.todayFocusSessions = 0;
    state.todayFocusMinutes = 0;
    saveState();
    render();
    setTransientStatus("Stats cleared");
  }

  function openAmbientDialog() {
    activeAmbientCategory = categoryForSound(state.settings.ambientSound);
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

  function switchAmbientCategory(categoryKey) {
    if (!ambientCategories[categoryKey]) {
      return;
    }

    activeAmbientCategory = categoryKey;
    renderAmbientControls();
  }

  // Update the selected ambient track. Choosing a rain option starts playback
  // immediately because the click is a trusted browser audio gesture.
  function chooseAmbientSound(soundKey) {
    if (!ambientSounds[soundKey]) {
      return;
    }

    state.settings.ambientSound = soundKey;
    saveState();

    if (soundKey === "off") {
      stopAmbientSound();
    } else {
      startAmbientSound();
    }

    render();
  }

  // Ambient Sounds can run independently from the timer.
  function toggleAmbientPlayback() {
    if (state.settings.ambientSound === "off") {
      return;
    }

    if (ambientState.isPlaying || ambientState.isPending) {
      stopAmbientSound();
    } else {
      startAmbientSound();
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

  // Start two audio elements for the chosen rain file; only one is audible at a
  // time, and the second is ready to overlap the first near the loop point.
  async function startAmbientSound() {
    const soundKey = state.settings.ambientSound;
    if (soundKey === "off" || !prepareAmbientPlayers(soundKey)) {
      stopAmbientSound();
      return;
    }

    if (ambientState.isPlaying || ambientState.isPending) {
      applyAmbientVolume();
      return;
    }

    const activePlayer = ambientState.players[ambientState.activeIndex];
    ambientState.isPending = true;
    activePlayer.loop = false;
    activePlayer.currentTime = 0;
    activePlayer.volume = targetAmbientVolume();

    try {
      await activePlayer.play();
      ambientState.isPlaying = true;
      startAmbientLoopMonitor();
    } catch {
      ambientState.isPlaying = false;
      setTransientStatus("Sound blocked");
    } finally {
      ambientState.isPending = false;
      renderAmbientControls();
    }
  }

  function stopAmbientSound() {
    window.clearInterval(ambientState.loopHandle);
    window.clearInterval(ambientState.fadeHandle);
    ambientState.loopHandle = null;
    ambientState.fadeHandle = null;
    ambientState.isPlaying = false;
    ambientState.isPending = false;
    ambientState.isCrossfading = false;

    ambientState.players.forEach((player) => {
      player.pause();
      player.currentTime = 0;
      player.loop = false;
      player.volume = 0;
    });

    renderAmbientControls();
  }

  function prepareAmbientPlayers(soundKey) {
    const sound = ambientSounds[soundKey];
    if (!sound || !sound.src) {
      return false;
    }

    if (ambientState.soundKey === soundKey && ambientState.players.length === 2) {
      return true;
    }

    stopAmbientSound();
    ambientState.soundKey = soundKey;
    ambientState.activeIndex = 0;
    ambientState.players = [createAmbientPlayer(sound.src), createAmbientPlayer(sound.src)];
    return true;
  }

  function createAmbientPlayer(src) {
    const player = new Audio(src);
    player.preload = "auto";
    player.loop = false;
    player.volume = 0;
    return player;
  }

  function startAmbientLoopMonitor() {
    window.clearInterval(ambientState.loopHandle);
    ambientState.loopHandle = window.setInterval(checkAmbientLoop, 180);
  }

  function checkAmbientLoop() {
    if (!ambientState.isPlaying || ambientState.isCrossfading) {
      return;
    }

    const activePlayer = ambientState.players[ambientState.activeIndex];
    if (!activePlayer || !Number.isFinite(activePlayer.duration) || activePlayer.duration <= 0) {
      return;
    }
    activePlayer.loop = false;

    const fadeSeconds = Math.min(AMBIENT_CROSSFADE_SECONDS, Math.max(0.7, activePlayer.duration * 0.25));
    if (activePlayer.duration - activePlayer.currentTime <= fadeSeconds) {
      crossfadeAmbientPlayers(fadeSeconds);
    }
  }

  async function crossfadeAmbientPlayers(fadeSeconds) {
    const fromPlayer = ambientState.players[ambientState.activeIndex];
    const nextIndex = ambientState.activeIndex === 0 ? 1 : 0;
    const toPlayer = ambientState.players[nextIndex];

    if (!fromPlayer || !toPlayer) {
      return;
    }

    ambientState.isCrossfading = true;
    fromPlayer.loop = false;
    toPlayer.loop = false;
    toPlayer.pause();
    toPlayer.currentTime = 0;
    toPlayer.volume = 0;

    try {
      await toPlayer.play();
    } catch {
      fromPlayer.loop = true;
      ambientState.isCrossfading = false;
      return;
    }

    const startedAt = window.performance.now();
    window.clearInterval(ambientState.fadeHandle);
    ambientState.fadeHandle = window.setInterval(() => {
      const elapsed = (window.performance.now() - startedAt) / 1000;
      const progress = Math.min(1, elapsed / fadeSeconds);
      const eased = easeInOut(progress);
      const targetVolume = targetAmbientVolume();

      fromPlayer.volume = targetVolume * (1 - eased);
      toPlayer.volume = targetVolume * eased;

      if (progress >= 1) {
        window.clearInterval(ambientState.fadeHandle);
        ambientState.fadeHandle = null;
        fromPlayer.pause();
        fromPlayer.currentTime = 0;
        fromPlayer.volume = 0;
        toPlayer.volume = targetVolume;
        ambientState.activeIndex = nextIndex;
        ambientState.isCrossfading = false;
      }
    }, 40);
  }

  function applyAmbientVolume() {
    if (!ambientState.players.length) {
      return;
    }

    const targetVolume = targetAmbientVolume();
    ambientState.players.forEach((player, index) => {
      if (!player.paused && !ambientState.isCrossfading) {
        player.volume = index === ambientState.activeIndex ? targetVolume : 0;
      }
    });
  }

  function targetAmbientVolume() {
    return Math.min(1, Math.max(0, state.settings.ambientVolume / 100));
  }

  function categoryForSound(soundKey) {
    const sound = ambientSounds[soundKey];
    if (!sound || !Array.isArray(sound.categories)) {
      return "focus";
    }

    return sound.categories.includes(activeAmbientCategory)
      ? activeAmbientCategory
      : sound.categories[0] || "focus";
  }

  function easeInOut(progress) {
    return progress < 0.5
      ? 2 * progress * progress
      : 1 - ((-2 * progress + 2) ** 2) / 2;
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

  // Ask the browser for notification permission and store the user's choice.
  async function requestNotifications() {
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

  // Runs the completion feedback: sound first, then optional browser notification.
  function announceCompletion(completedMode) {
    const mode = modes[completedMode];

    if (state.settings.sound) {
      playChime(completedMode);
    }

    if (
      state.settings.notifications &&
      "Notification" in window &&
      Notification.permission === "granted"
    ) {
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
    elements.clearStatsButton.disabled = state.todayFocusSessions === 0 && state.todayFocusMinutes === 0;
    renderAmbientControls();
    renderStatus();
  }

  function renderAmbientControls() {
    const soundKey = ambientSounds[state.settings.ambientSound] ? state.settings.ambientSound : "off";
    const sound = ambientSounds[soundKey];
    const isOff = soundKey === "off";

    elements.ambientLabel.textContent = ambientState.isPlaying ? `${sound.label} playing` : sound.label;
    elements.ambientVolume.value = state.settings.ambientVolume;
    elements.ambientVolumeValue.textContent = `${state.settings.ambientVolume}%`;
    elements.ambientVolume.disabled = isOff;
    elements.ambientToggleButton.disabled = isOff;
    elements.ambientToggleButton.textContent = ambientState.isPending
      ? "Loading"
      : ambientState.isPlaying
        ? "Stop"
        : "Play";
    elements.ambientToggleButton.setAttribute("aria-pressed", String(ambientState.isPlaying));

    elements.ambientCategoryTabs.forEach((button) => {
      const isActive = button.dataset.category === activeAmbientCategory;
      button.classList.toggle("is-active", isActive);
      button.setAttribute("aria-selected", String(isActive));
    });

    renderAmbientLibrary(soundKey);
  }

  function renderAmbientLibrary(selectedSoundKey) {
    const fragment = document.createDocumentFragment();

    Object.entries(ambientSounds)
      .filter(([, sound]) => sound.categories.includes(activeAmbientCategory))
      .forEach(([soundKey, sound]) => {
        const button = document.createElement("button");
        const isSelected = soundKey === selectedSoundKey;
        button.className = "ambient-sound-card";
        button.type = "button";
        button.dataset.sound = soundKey;
        button.setAttribute("role", "radio");
        button.setAttribute("aria-checked", String(isSelected));
        button.classList.toggle("is-active", isSelected);

        const copy = document.createElement("span");
        copy.className = "ambient-sound-copy";

        const label = document.createElement("span");
        label.textContent = sound.label;

        const tone = document.createElement("small");
        tone.textContent = sound.tone;

        copy.append(label, tone);
        button.appendChild(copy);
        button.addEventListener("click", () => chooseAmbientSound(soundKey));
        fragment.appendChild(button);
      });

    elements.ambientLibrary.replaceChildren(fragment);
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
