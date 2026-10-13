export interface ActivitySource<Frame> {
  getFrame(): Frame;
  destroy(): void;
}

type FrameListener<Frame> = (frame: Frame | null) => void;
type SourceFactory<Frame> = (
  identity: string,
  publish: (frame: Frame) => void,
) => Promise<ActivitySource<Frame>>;

interface SourceEntry<Frame> {
  listeners: Set<FrameListener<Frame>>;
  frame: Frame | null;
  source?: ActivitySource<Frame>;
}

/** One running engine per identity, including views mounted after activity began. */
export class ActivitySourcePool<Frame> {
  private readonly entries = new Map<string, SourceEntry<Frame>>();

  constructor(private readonly createSource: SourceFactory<Frame>) {}

  subscribe(identity: string, listener: FrameListener<Frame>): () => void {
    let entry = this.entries.get(identity);
    if (!entry) {
      entry = { listeners: new Set(), frame: null };
      this.entries.set(identity, entry);
      const current = entry;
      void this.createSource(identity, (frame) => {
        if (this.entries.get(identity) !== current) return;
        current.frame = frame;
        for (const subscriber of current.listeners) subscriber(frame);
      })
        .then((source) => {
          if (this.entries.get(identity) !== current) {
            source.destroy();
            return;
          }
          current.source = source;
          current.frame = source.getFrame();
          for (const subscriber of current.listeners) subscriber(current.frame);
        })
        .catch(() => {
          // The static child remains visible if the deferred motion chunk fails.
          if (this.entries.get(identity) !== current) return;
          for (const subscriber of current.listeners) subscriber(null);
        });
    }
    entry.listeners.add(listener);
    if (entry.frame) listener(entry.frame);

    return () => {
      entry.listeners.delete(listener);
      if (entry.listeners.size !== 0 || this.entries.get(identity) !== entry) return;
      this.entries.delete(identity);
      entry.source?.destroy();
    };
  }
}
