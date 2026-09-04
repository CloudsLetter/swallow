import { SessionReplayPlayer } from './SessionReplay';
import type { ReplayTabConfig } from '../store/tabStore';

interface ReplayViewProps {
  replayConfig: ReplayTabConfig;
}

/** 独立回放标签：使用与普通终端一致的内容区生命周期，播放器本身是只读 xterm。 */
export function ReplayView({ replayConfig }: ReplayViewProps) {
  return (
    <SessionReplayPlayer
      open
      path={replayConfig.path}
      replay={replayConfig.replay}
    />
  );
}
