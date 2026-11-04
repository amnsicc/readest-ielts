"""Compare a native playback capture with the original recording via decoded PCM."""

import array
import json
import math
import subprocess
import sys


RATE = 2000


def decode(path):
    raw = subprocess.check_output(
        [
            "ffmpeg", "-nostdin", "-v", "error", "-i", path,
            "-vn", "-ac", "1", "-ar", str(RATE), "-f", "s16le", "-",
        ],
    )
    samples = array.array("h")
    samples.frombytes(raw)
    if sys.byteorder != "little":
        samples.byteswap()
    return samples


def correlate(original, capture, start, end):
    first, last = int(start * RATE), int(end * RATE)
    reference = original[first:last]
    norm = sum(sample * sample for sample in reference)
    best = (-1.0, 0)
    for lag in range(-RATE, RATE + 1):
        if first + lag < 0 or last + lag > len(capture):
            continue
        candidate = capture[first + lag:last + lag]
        energy = sum(sample * sample for sample in candidate)
        if not energy:
            continue
        cross = sum(a * b for a, b in zip(reference, candidate))
        best = max(best, (cross / math.sqrt(norm * energy), lag))
    score, lag = best
    return {"from": start, "to": end, "score": score, "offsetSeconds": lag / RATE}


if __name__ == "__main__":
    if len(sys.argv) != 3:
        raise SystemExit("Usage: compare-ielts-audio.py <original.mp3> <capture.webm>")
    source, played = map(decode, sys.argv[1:])
    observations = [correlate(source, played, start, end) for start, end in [
        (4.0, 4.7), (24.0, 24.7), (43.0, 43.7), (62.0, 62.7), (78.0, 78.7),
    ]]
    duration = len(played) / RATE
    print(json.dumps({
        "sourceSeconds": len(source) / RATE,
        "captureSeconds": duration,
        "observations": observations,
    }, indent=2))
    if abs(duration - len(source) / RATE) > 1 or any(row["score"] < 0.85 for row in observations):
        raise SystemExit("Native playback capture does not match the source recording.")
