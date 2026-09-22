import { readFileSync, writeFileSync } from 'node:fs'
const p = 'scripts/status.mjs'
let s = readFileSync(p, 'utf8')
const NL = '\n'
// ① 使い方の説明を差し替える
const old = s.split(NL).find((l) => l.includes('<b>使い方</b>'))
if (!old) { console.log('N1'); process.exit(1) }
const neu = [
  '    `<div class="note"><b>使い方</b><br>',
  '締切前にオッズを見て、<b>表示の倍率以上なら単勝を買う</b>。下回っていれば見送る。<br>',
  '<b>1レースで複数出たら、条件を満たしたものは全部買う</b>。1艇に絞ると回収率が9〜21pt下がる（実測）。',
  '</div>`',
  '    + `<div class="note2"><b>この一覧は「候補」です</b><br>',
  '朝はオッズが分からないので、ここでは買う艇を決められません。<b>見張る対象</b>を並べています。<br>',
  'オッズが必要倍率に届くのは一部だけで、実測では<b>見張り515本のうち実際に買うのは1日64本</b>、',
  '<b>7割のレースは1本も買いません</b>。<br>',
  '必要倍率が30倍を超えるものは現実に届かないので隠しています。',
  '</div>` + (body || "<div class=\\"note\\">条件に合う艇がありません。</div>")',
].join(NL)
s = s.replace(old, neu)
// ② note2 のスタイルを足す
const st = ".note{background:var(--card);border:1px solid var(--line);border-left:3px solid var(--warn);"
if (!s.includes('.note2{')) {
  s = s.replace(st, ".note2{background:var(--card);border:1px solid var(--line);border-left:3px solid var(--sub);" + NL +
    "border-radius:8px;padding:11px 13px;font-size:12.5px;color:var(--sub);margin-bottom:12px}'," + NL + "'" + st)
}
writeFileSync(p, s)
console.log('ok')
