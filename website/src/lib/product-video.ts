export function enhanceProductVideo(player: HTMLElement) {
  const video = player.querySelector<HTMLVideoElement>("video")!;
  const controls = player.querySelector<HTMLElement>(".video-controls")!;
  const cover = player.querySelector<HTMLButtonElement>("[data-cover]")!;
  const coverLabel = player.querySelector<HTMLElement>("[data-cover-label]")!;
  const play = player.querySelector<HTMLButtonElement>("[data-play]")!;
  const seek = player.querySelector<HTMLInputElement>("[data-seek]")!;
  const time = player.querySelector<HTMLElement>("[data-time]")!;
  const duration = player.querySelector<HTMLElement>("[data-duration]")!;
  const mute = player.querySelector<HTMLButtonElement>("[data-mute]")!;
  const volume = player.querySelector<HTMLInputElement>("[data-volume]")!;
  const captions = player.querySelector<HTMLButtonElement>("[data-captions]")!;
  const fullscreen =
    player.querySelector<HTMLButtonElement>("[data-fullscreen]")!;
  const message = player.querySelector<HTMLElement>(".video-message")!;
  const messageText = player.querySelector<HTMLElement>("[data-message]")!;
  // iPhone Safari exposes fullscreen on the video instead of its container.
  const mobileVideo = video as HTMLVideoElement & {
    webkitEnterFullscreen?: () => void;
  };
  let started = false;
  let failed = false;

  const formatTime = (seconds: number) => {
    const value = Math.max(0, Math.floor(seconds));
    return `${Math.floor(value / 60)}:${String(value % 60).padStart(2, "0")}`;
  };
  const labelButton = (button: HTMLButtonElement, label: string) => {
    button.setAttribute("aria-label", label);
    button.title = label;
  };
  const showMessage = (text: string) => {
    messageText.textContent = text;
    message.hidden = false;
  };
  const syncPlayback = () => {
    const playing = !video.paused && !video.ended;
    player.dataset.playing = String(playing);
    labelButton(
      play,
      video.ended ? "Replay video" : playing ? "Pause video" : "Play video",
    );
    coverLabel.textContent = video.ended ? "Watch again" : "Watch the film";
    cover.hidden = started && !video.ended;
  };
  const syncProgress = () => {
    if (!Number.isFinite(video.duration) || video.duration <= 0) return;
    seek.disabled = false;
    seek.max = String(video.duration);
    seek.value = String(video.currentTime);
    seek.style.setProperty(
      "--progress",
      `${(video.currentTime / video.duration) * 100}%`,
    );
    time.textContent = formatTime(video.currentTime);
    duration.textContent = formatTime(video.duration);
    seek.setAttribute(
      "aria-valuetext",
      `${time.textContent} of ${duration.textContent}`,
    );
  };
  const syncVolume = () => {
    const silent = video.muted || video.volume === 0;
    player.dataset.muted = String(silent);
    labelButton(mute, silent ? "Unmute video" : "Mute video");
    volume.value = String(video.muted ? 0 : video.volume);
    volume.style.setProperty("--progress", `${Number(volume.value) * 100}%`);
    volume.setAttribute(
      "aria-valuetext",
      `${Math.round(Number(volume.value) * 100)}%`,
    );
  };
  const syncCaptions = () => {
    captions.setAttribute(
      "aria-pressed",
      String(video.textTracks[0]?.mode === "showing"),
    );
  };
  const togglePlayback = async () => {
    message.hidden = true;
    if (!video.paused && !video.ended) {
      video.pause();
      return;
    }
    try {
      if (failed) {
        failed = false;
        video.load();
      }
      await video.play();
    } catch (error) {
      if (!(error instanceof DOMException && error.name === "AbortError")) {
        showMessage("Playback could not start. Please try again.");
      }
    }
  };

  cover.addEventListener("click", () => {
    play.focus({ preventScroll: true });
    void togglePlayback();
  });
  play.addEventListener("click", togglePlayback);
  video.addEventListener("click", togglePlayback);
  video.addEventListener("play", () => {
    started = true;
    syncPlayback();
  });
  for (const event of ["pause", "ended", "seeked"])
    video.addEventListener(event, syncPlayback);
  for (const event of ["timeupdate", "durationchange", "loadedmetadata"])
    video.addEventListener(event, syncProgress);
  seek.addEventListener("input", () => {
    video.currentTime = Number(seek.value);
    syncProgress();
  });
  mute.addEventListener("click", () => {
    if (video.volume === 0) {
      video.volume = 1;
      video.muted = false;
    } else video.muted = !video.muted;
  });
  volume.addEventListener("input", () => {
    video.volume = Number(volume.value);
    video.muted = video.volume === 0;
  });
  video.addEventListener("volumechange", syncVolume);
  captions.addEventListener("click", () => {
    const track = video.textTracks[0];
    if (track) track.mode = track.mode === "showing" ? "disabled" : "showing";
    syncCaptions();
  });
  video.textTracks.addEventListener("change", syncCaptions);
  video.querySelector("track")?.addEventListener("error", () => {
    captions.disabled = true;
    showMessage("Captions could not load. The transcript is available below.");
  });
  const mediaError = () => {
    video.pause();
    failed = true;
    started = false;
    syncPlayback();
    showMessage("The video could not load. Please try opening it directly.");
  };
  video.addEventListener("error", mediaError);
  video.querySelector("source")?.addEventListener("error", mediaError);

  fullscreen.hidden =
    !document.fullscreenEnabled && !mobileVideo.webkitEnterFullscreen;
  fullscreen.addEventListener("click", async () => {
    try {
      if (document.fullscreenElement === player)
        await document.exitFullscreen();
      else if (document.fullscreenEnabled) await player.requestFullscreen();
      else mobileVideo.webkitEnterFullscreen?.();
    } catch {
      showMessage("Fullscreen is unavailable in this browser.");
    }
  });
  document.addEventListener("fullscreenchange", () => {
    const expanded = document.fullscreenElement === player;
    player.dataset.fullscreen = String(expanded);
    labelButton(fullscreen, expanded ? "Exit fullscreen" : "Enter fullscreen");
  });

  syncPlayback();
  syncProgress();
  syncVolume();
  syncCaptions();
  // Keep native controls when JavaScript is unavailable or initialization fails.
  video.controls = false;
  controls.hidden = false;
  player.dataset.enhanced = "true";
}
