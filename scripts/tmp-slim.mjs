import { readFileSync, writeFileSync, statSync } from 'node:fs'
const d = process.argv[2] ?? '2026-08-31'
const j = JSON.parse(readFileSync(`data/predict-${d}.json`, 'utf8'))
const r4 = (v) => Math.round(v * 10000) / 10000
const slim = {
  date: j.date, generatedAt: j.generatedAt,
  races: (j.races ?? []).map((r) => ({
    race_id: r.race_id, venue: r.venue, race_no: r.race_no, grade: r.grade,
    first: (r.first ?? []).map((b) => ({ lane: b.lane, name: b.name, p: r4(b.p) })),
    sanrentan: (r.sanrentan ?? []).slice(0, 6).map((x) => ({ combo: x.combo, p: r4(x.p) })),
    sanrenpuku: (r.sanrenpuku ?? []).slice(0, 4).map((x) => ({ combo: x.combo, p: r4(x.p) })),
  })),
}
writeFileSync(`data/slim-${d}.json`, JSON.stringify(slim))
console.log(`元 ${(statSync(`data/predict-${d}.json`).size / 1024).toFixed(0)}KB → 要点版 ${(statSync(`data/slim-${d}.json`).size / 1024).toFixed(0)}KB / ${slim.races.length}レース`)
