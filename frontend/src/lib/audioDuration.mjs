export function finiteDurationOrNull(value) {
    return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

export function formatAudioTime(value, unavailable = "--:--") {
    const seconds = finiteDurationOrNull(value);
    if (seconds == null) return unavailable;
    const minutes = Math.floor(seconds / 60);
    const remainder = Math.floor(seconds % 60);
    return `${minutes}:${remainder < 10 ? "0" : ""}${remainder}`;
}
