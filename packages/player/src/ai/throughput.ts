/** Rolling throughput of completed uncached work. Concurrent wall time counts only once. */
export class GenerationThroughput {
  private samples: Array<{ start: number; end: number; seconds: number }> = [];

  add(start: number, end: number, seconds: number): void {
    if (![start, end, seconds].every(Number.isFinite) || end <= start || seconds <= 0) return;
    this.samples.push({ start, end, seconds });
    this.samples = this.samples.slice(-24);
  }

  get speed(): number | undefined {
    const samples = [...this.samples].sort((a, b) => a.start - b.start);
    let wall = 0;
    let end = -Infinity;
    for (const sample of samples) {
      wall += Math.max(0, sample.end - Math.max(end, sample.start));
      end = Math.max(end, sample.end);
    }
    return samples.length >= 4 && wall >= 1000 ? samples.reduce((n, s) => n + s.seconds, 0) / (wall / 1000) : undefined;
  }
}

export function throughputState(speed: number | undefined, tempo: number): 'measuring' | 'behind' | 'tight' | 'keepingUp' {
  if (speed === undefined) return 'measuring';
  if (speed < tempo) return 'behind';
  return speed < tempo * 1.15 ? 'tight' : 'keepingUp';
}
