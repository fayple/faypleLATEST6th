// Text matching used by the Download Games search (typo-tolerant ranking).

export function norm(s: unknown): string {
  return String(s ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

// Optimal-string-alignment distance (counts a swapped pair like "ae"→"ea" as 1).
// Returns max+1 straight away when the length gap alone already exceeds `max`.
export function lev(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const m = a.length, n = b.length;
  let prev2: number[] = [];
  let prev: number[] = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur: number[] = [i];
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, prev2[j - 2] + 1);
      cur[j] = v;
    }
    prev2 = prev;
    prev = cur;
  }
  return prev[n];
}

const maxTypos = (len: number) => (len <= 3 ? 0 : Math.min(3, Math.floor(len / 4)));

/** 0–100: how well a game name matches what the person typed. */
export function relevance(query: string, name: string): number {
  const q = norm(query), n = norm(name);
  if (!q || !n) return 0;
  if (n === q) return 100;
  let score = 0;
  if (n.startsWith(q)) score = 90;
  else if (n.includes(q)) score = 76;

  const qt = q.split(" "), nt = n.split(" ");
  let sum = 0;
  for (const t of qt) {
    let best = 0;
    for (const w of nt) {
      if (w === t) best = Math.max(best, 1);
      else if (t.length >= 2 && w.startsWith(t)) best = Math.max(best, 0.85);
      else if (t.length >= 4 && w.includes(t)) best = Math.max(best, 0.6);
      else {
        const d = maxTypos(t.length);
        if (d > 0) {
          const dist = lev(t, w, d);
          if (dist <= d) best = Math.max(best, dist === 1 ? 0.75 : 0.6);
        }
      }
    }
    sum += best;
  }
  score = Math.max(score, (sum / qt.length) * 72);

  // Spacing differences and typos across the whole title: "steal alava" ≈ "Steal a Lava".
  const qc = q.replace(/ /g, ""), nc = n.replace(/ /g, "");
  if (qc.length >= 4) {
    if (nc.includes(qc)) score = Math.max(score, 72);
    const d = maxTypos(qc.length);
    if (d > 0) {
      const dist = Math.min(lev(qc, nc, d), lev(qc, nc.slice(0, qc.length), d));
      if (dist <= d) score = Math.max(score, 66 - dist * 6);
    }
  }
  return Math.min(100, score);
}
