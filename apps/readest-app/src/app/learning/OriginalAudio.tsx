'use client';

import { useEffect, useRef, useState } from 'react';
import { BlobAudioClock } from '@/services/audiobook/AudiobookClock';
import { getStudyAsset } from '@/services/learning/studyAssets';

const duration = 82.152;
const timeLabel = (seconds: number) =>
  `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;

export function OriginalAudio({ sha256 }: { sha256: string }) {
  const clock = useRef<BlobAudioClock | null>(null);
  const [ready, setReady] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    const audio = new BlobAudioClock(
      async () =>
        new Blob([await getStudyAsset('listening.mp3', sha256, controller.signal)], {
          type: 'audio/mpeg',
        }),
    );
    clock.current = audio;
    audio.addEventListener('timeupdate', () => {
      if (active) setTime(audio.currentTime);
    });
    audio.addEventListener('ended', () => {
      if (active) setPlaying(false);
    });
    audio.addEventListener('error', () => {
      if (active) {
        setReady(false);
        setPlaying(false);
        setError('无法播放原音。');
      }
    });
    void audio
      .load('listening.mp3', 0)
      .then(() => {
        if (active) setReady(true);
      })
      .catch(() => {
        if (active) setError('原音读取失败。');
      });
    return () => {
      active = false;
      controller.abort();
      audio.destroy();
      clock.current = null;
    };
  }, [sha256, retry]);
  async function toggle() {
    const audio = clock.current;
    if (!audio) return;
    if (!audio.paused) {
      audio.pause();
      setPlaying(false);
      return;
    }
    setError('');
    try {
      await audio.play();
      if (clock.current === audio) setPlaying(!audio.paused);
    } catch {
      if (clock.current === audio) setError('播放未能开始，请重试。');
    }
  }
  return (
    <section
      aria-label='固定原音'
      className='eink-bordered bg-base-100 space-y-2 rounded-xl border border-base-300 p-3'
    >
      <div className='flex flex-wrap items-center gap-3'>
        <button
          type='button'
          className='btn btn-contrast min-w-20'
          disabled={!ready}
          onClick={() => void toggle()}
        >
          {playing ? '暂停' : '播放原音'}
        </button>
        <input
          type='range'
          aria-label='原音播放位置'
          className='range range-sm min-w-24 flex-1'
          min={0}
          max={duration}
          step={0.1}
          value={time}
          disabled={!ready}
          onChange={(event) => {
            const seconds = Number(event.target.value);
            if (clock.current) {
              clock.current.currentTime = seconds;
              setTime(seconds);
            }
          }}
        />
        <span className='text-sm tabular-nums' aria-label='原音时间'>
          {timeLabel(time)} / {timeLabel(duration)}
        </span>
      </div>
      {error && (
        <p role='alert'>
          {error}{' '}
          <button
            type='button'
            className='btn btn-sm btn-ghost'
            onClick={() => {
              setError('');
              setReady(false);
              setTime(0);
              setRetry((n) => n + 1);
            }}
          >
            重试原音
          </button>
        </p>
      )}
    </section>
  );
}
