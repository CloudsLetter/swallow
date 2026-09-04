import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pause, Play, RotateCcw } from 'lucide-react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from './ui/dialog';
import { Button } from './ui/button';
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from './ui/select';
import { Slider } from './ui/slider';
import type { SessionReplayData } from '../services/sessionReplay';

interface SessionReplayProps {
  open: boolean;
  path?: string;
  replay: SessionReplayData | null;
  onOpenChange: (open: boolean) => void;
}

interface SessionReplayPlayerProps {
  open: boolean;
  path?: string;
  replay: SessionReplayData | null;
}

function formatTime(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

export function SessionReplayPlayer({ open, path, replay }: SessionReplayPlayerProps) {
  const { t } = useTranslation();
  const terminalHostRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const replayRef = useRef<SessionReplayData | null>(replay);
  const eventIndexRef = useRef(0);
  const positionRef = useRef(0);
  const frameRef = useRef<number>(0);
  const [position, setPosition] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState('1');

  const setPlaybackPosition = (value: number) => {
    positionRef.current = value;
    setPosition(value);
  };

  const renderUntil = (target: number) => {
    const terminal = terminalRef.current;
    const currentReplay = replayRef.current;
    if (!terminal || !currentReplay) {
      setPlaybackPosition(target);
      return;
    }

    const snapshot = currentReplay.snapshots
      .filter((candidate) => candidate.at <= target)
      .slice(-1)[0];
    terminal.reset();
    eventIndexRef.current = 0;
    if (snapshot) {
      // SerializeAddon 输出的是可重新写回 xterm 的 VT 状态串，恢复后只需补放后续事件。
      terminal.write(snapshot.data);
      eventIndexRef.current = currentReplay.events.findIndex((event) => event.at > snapshot.at);
      if (eventIndexRef.current < 0) eventIndexRef.current = currentReplay.events.length;
    }
    while (
      eventIndexRef.current < currentReplay.events.length &&
      currentReplay.events[eventIndexRef.current].at <= target
    ) {
      const event = currentReplay.events[eventIndexRef.current];
      if (event.direction === 'output') terminal.write(event.data);
      eventIndexRef.current += 1;
    }
    setPlaybackPosition(target);
  };

  useEffect(() => {
    replayRef.current = replay;
  }, [replay]);

  useEffect(() => {
    if (!open || !replay || !terminalHostRef.current) return;

    const terminal = new Terminal({
      cursorBlink: false,
      disableStdin: true,
      convertEol: true,
      scrollback: 10000,
      fontFamily: 'Consolas, "Courier New", monospace',
      fontSize: 14,
      theme: {
        background: '#0f172a',
        foreground: '#e2e8f0',
        cursor: '#818cf8',
      },
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(terminalHostRef.current);
    fit.fit();
    terminalRef.current = terminal;
    replayRef.current = replay;
    eventIndexRef.current = 0;
    renderUntil(0);
    // 打开后立即播放，避免首个事件尚未到达时看起来像空白窗口。
    setPlaying(true);

    const resize = () => fit.fit();
    window.addEventListener('resize', resize);
    return () => {
      window.removeEventListener('resize', resize);
      terminal.dispose();
      terminalRef.current = null;
    };
  }, [open, replay]);

  useEffect(() => {
    if (!open || !replay || !playing) return;

    const multiplier = Number(speed) || 1;
    const startedAt = performance.now() - positionRef.current / multiplier;
    const tick = () => {
      const elapsed = Math.min(replay.duration, (performance.now() - startedAt) * multiplier);
      while (
        eventIndexRef.current < replay.events.length &&
        replay.events[eventIndexRef.current].at <= elapsed
      ) {
        const event = replay.events[eventIndexRef.current];
        if (event.direction === 'output') terminalRef.current?.write(event.data);
        eventIndexRef.current += 1;
      }
      setPlaybackPosition(elapsed);
      if (elapsed >= replay.duration) {
        setPlaying(false);
        return;
      }
      frameRef.current = requestAnimationFrame(tick);
    };

    frameRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frameRef.current);
  }, [open, replay, playing, speed]);

  const togglePlaying = () => {
    if (!replay) return;
    if (positionRef.current >= replay.duration) renderUntil(0);
    setPlaying((value) => !value);
  };

  const seek = (value: number) => {
    setPlaying(false);
    renderUntil(Math.max(0, Math.min(replay?.duration ?? 0, value)));
  };

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-background">
      <div className="flex shrink-0 items-center gap-3 border-b border-border px-4 py-2">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{replay?.label || t('logs.replayTitle')}</p>
          <p className="truncate text-xs text-muted-foreground">{path || t('logs.replayTitle')}</p>
        </div>
        <span className="shrink-0 text-xs text-muted-foreground">{t('logs.replayFormatHint')}</span>
      </div>

      <div ref={terminalHostRef} className="min-h-0 flex-1 bg-slate-950 p-2" />

      <div className="flex shrink-0 flex-wrap items-center gap-3 border-t border-border bg-background p-3">
        <Button variant="secondary" size="sm" onClick={() => void togglePlaying()} disabled={!replay}>
          {playing ? <Pause data-icon="inline-start" /> : <Play data-icon="inline-start" />}
          {playing ? t('logs.replayPause') : t('logs.replayPlay')}
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={() => seek(0)}
          disabled={!replay}
          aria-label={t('logs.replayRestart')}
          title={t('logs.replayRestart')}
        >
          <RotateCcw />
        </Button>
        <Select value={speed} onValueChange={setSpeed}>
          <SelectTrigger className="w-24" aria-label={t('logs.replaySpeed')}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              <SelectItem value="0.5">0.5x</SelectItem>
              <SelectItem value="1">1x</SelectItem>
              <SelectItem value="2">2x</SelectItem>
              <SelectItem value="4">4x</SelectItem>
            </SelectGroup>
          </SelectContent>
        </Select>
        <Slider
          className="min-w-48 flex-1"
          value={[position]}
          max={Math.max(1, replay?.duration ?? 1)}
          step={1}
          disabled={!replay}
          onValueChange={([value]) => setPlaybackPosition(value)}
          onValueCommit={([value]) => seek(value)}
          aria-label={t('logs.replayTimeline')}
        />
        <span className="min-w-24 text-right font-mono text-xs text-muted-foreground">
          {formatTime(position)} / {formatTime(replay?.duration ?? 0)}
        </span>
      </div>
    </div>
  );
}

/** 兼容旧调用方的弹窗播放器；新的入口使用 ReplayView 创建独立标签。 */
export function SessionReplay({ open, path, replay, onOpenChange }: SessionReplayProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[min(760px,90vh)] w-[min(1100px,calc(100vw-2rem))] max-w-none flex-col gap-0 overflow-hidden p-0">
        <DialogHeader className="sr-only">
          <DialogTitle>{replay?.label || 'Session Replay'}</DialogTitle>
          <DialogDescription>{path || 'ANSI/VT replay'}</DialogDescription>
        </DialogHeader>
        <SessionReplayPlayer open={open} path={path} replay={replay} />
      </DialogContent>
    </Dialog>
  );
}
