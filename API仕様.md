# 凪の予想配信 データAPI 仕様（v1）

Webサイト（デザインはGPTで作る）・note記事の自動生成・将来のアプリが、同じ窓口から同じデータを読むためのAPIです。
中身は `scripts/api.mjs`、窓口は確認用サーバー（`scripts/status.mjs`・ポート3940）です。

- このPCから：`http://localhost:3940/api/v1`
- 同じWi-Fiのスマホから：`http://<PCのIPアドレス>:3940/api/v1`
- 一覧（このAPI自身の説明）：`/api/v1` を開くと、使えるURLがJSONで返ります

## 共通の決まり

| 項目 | 内容 |
|---|---|
| 形式 | すべて JSON（UTF-8） |
| 時刻 | すべて**日本時間**。`deadline` は `"HH:MM"`、`now` などは `"YYYY-MM-DD HH:MM"` |
| 日付の指定 | `?date=YYYY-MM-DD`。省くと今日 |
| レースID | `YYYYMMDD-JJ-RR`（例 `20260921-05-12` ＝ 2026/9/21 多摩川12R）。JJ＝場コード、RR＝レース番号 |
| 確率 | **%（小数1桁）**。例 `44.4` ＝ 44.4% |
| 予想がまだ無い日 | `"status": "empty"` を返す。**このときは記事やページを作らないこと** |
| 締切済み | `"closed": true`。今日のレースで締切時刻を過ぎたもの・過去日のレース |
| 中止・順延 | `"cancelled": true` |
| エラー | 400（指定が違う）・404（見つからない）・500（取得失敗）。どれも `{"error": "理由"}` |

### ⚠ 有料の部分（access: "paid"）
`prediction`（買い目の元になる確率）と `picks`（記録した買い目）は、**noteで1点200円・月額1000円で販売している中身**です。
**公開するサイトやアプリの無料部分には出さないでください。** 有料会員向けの画面を作るときだけ使います。

## 場コード

| JJ | 場 | JJ | 場 | JJ | 場 | JJ | 場 |
|---|---|---|---|---|---|---|---|
| 01 | 桐生 | 07 | 蒲郡 | 13 | 尼崎 | 19 | 下関 |
| 02 | 戸田 | 08 | 常滑 | 14 | 鳴門 | 20 | 若松 |
| 03 | 江戸川 | 09 | 津 | 15 | 丸亀 | 21 | 芦屋 |
| 04 | 平和島 | 10 | 三国 | 16 | 児島 | 22 | 福岡 |
| 05 | 多摩川 | 11 | びわこ | 17 | 宮島 | 23 | 唐津 |
| 06 | 浜名湖 | 12 | 住之江 | 18 | 徳山 | 24 | 大村 |

---

## 1. レース一覧　`/api/v1/races?date=YYYY-MM-DD`　（無料）
その日の全レース。トップページや「きょうのレース」一覧に使う。

```json
{
 "date": "2026-09-21", "status": "ok",
 "prediction_ready": true, "prediction_generated_at": "2026-09-21 15:41",
 "races": [
  { "race_id": "20260921-01-01", "venue": "桐生", "jcd": 1, "race_no": 1, "deadline": "15:26",
    "title": "予選女子", "series": "第２０回マンスリーＢＯＡＴＲＡＣＥ杯", "day_no": 2, "series_days": 6, "grade": null,
    "closed": true, "cancelled": false,
    "result": { "order": "3-2-6", "kimarite": "まくり差し", "win_payout": 150, "trifecta_payout": 1540, "trio_payout": 550, "source": "競走成績" },
    "favorite": { "lane": 1, "name": "飯塚響", "win_probability": 59.7 },
    "has_paid_picks": false }
 ]
}
```
- `result` は結果が出るまで `null`。`source` は `"速報"`（当日）か `"競走成績"`（翌日以降・こちらが正）。`kimarite` は競走成績が来てから入る
- `favorite` は1着確率がいちばん高い艇（本命）
- `has_paid_picks` はそのレースに有料の買い目があるか（中身は出さない）

## 2. 1レースの全部　`/api/v1/race?id=YYYYMMDD-JJ-RR`　（無料＋有料）
レース詳細ページに使う。上の一覧の項目に加えて：

- **`entries`**（出走表・6艇）：`lane`（枠）・`racer_id`・`name`・`kana`・`class`（A1〜B2）・`age`・`branch`（支部）・`weight`・
  `win_rate_national`／`top2_rate_national`（全国勝率・2連対率）・`win_rate_local`／`top2_rate_local`（当地）・
  `motor_no`／`motor_top2_rate`・`boat_no`／`boat_top2_rate`・`avg_st`（直近60走の平均ST）・`f_count`（過去180日のF回数）・
  `win_probability`（1着確率）・`top2_probability`（2着以内の確率）
- **`entries[].before`**（直前情報・展示のあと）：`weight`（体重）・`adjust_weight`（調整重量）・`exhibition_time`（展示タイム）・`exhibition_rank`（展示タイムの順位）・`tilt`（チルト）・`parts_changed`（部品交換）・`start_course`（スタート展示の進入コース）・`start_st`（展示ST）・`start_flag`（`F`＝展示でのフライング、`L`＝出遅れ）。展示前は `null`
- **`entries[].stats_1y`**（基本情報・直近1年）：`starts`・`win_rate`・`top2_rate`・`top3_rate`・`avg_st`・`avg_st_rank`（同じレース内のST順位の平均）・`accidents`（`flying`/`late`/`disqualified`）・`accident_rate`・`yusho`/`yushutsu`/`junyu`（優勝・優出・準優出）・`titles_since_2022`・`maezuke_rate`
- **`entries[].course_stats`**（枠別情報）：今回入るコース（展示の進入、無ければ枠）での直近1年の成績。`wins_by_kimarite`、1コースなら `escape_rate`（逃げ率）と `lost_to`（差され・まくられ・まくり差され・抜かれ/恵まれの率）
- **`entries[].motor`**（モータ情報）：`period_from`（今期の始まり＝モーター入れ替え）・`total`（今期の1着/2連/3連率）・`last_30d`・`avg_exhibition_recent`・`users`（過去の使用者と着順）
- **`entries[].konsetsu`**（今節成績）：`series_result`（番組表の今節着順）・`races`（前日までの内訳）・`top2_rate`・`avg_st`
- **`conditions`**（水面気象）：`weather`・`air_temp`・`water_temp`・`wind_speed`（m）・`wind_dir`（公式の風向図の番号 1〜16、17は無風）・`wave`（cm）・`before_info`（`展示まで取得済み`／`展示前`）・`fetched_at`
  当日は締切の20分前から公式の直前情報を取りに行き、展示が揃うまで数分おきに取り直します
- **`tenkai`**（展開予想）：下の3.と同じ中身
- **`prediction`**（有料）：`confidence`（自信度）・`trio`（3連複・上位8点）・`trifecta`（3連単・上位24点）・`exacta`（2連単・上位8点）。すべて確率つき
- **`picks`**（有料）：そのレースで記録した買い目。5.と同じ中身

⚠ `avg_st`・`f_count` は公式出走表の値ではなく、当システムが出走履歴から計算した参考値。画面に出すときは注記すること。

## 3. 展開予想　`/api/v1/tenkai?date=YYYY-MM-DD`　（無料）
全レースの展開予想。レース展開の記事・画像に使う。

```json
{ "race_id": "20260921-05-12", "venue": "多摩川", "race_no": 12, "deadline": "16:30", "closed": true, "result": {...},
  "tenkai": {
   "shape": "混戦",
   "honmei": { "role": "本線", "lane": 1, "name": "原田篤志", "win_probability": 44.4, "likely_move": "逃げ", "avg_st": 0.16, "start": "普通" },
   "taiko":  { "role": "対抗", "lane": 3, "name": "丸野一樹", "win_probability": 19.7, "likely_move": "まくり", "avg_st": 0.11, "start": "速い" },
   "third":  { "role": "3番手", ... },
   "kimarite": [ { "kimarite": "逃げ", "probability": 43.1 }, { "kimarite": "まくり", "probability": 19.7 }, ... ],
   "summary": "本線は1号艇 原田篤志の逃げ（1着44.4%）。対抗は3号艇 丸野一樹のまくり（19.7%）。平均ST0.11と速く、仕掛ける余地あり。決まり手は逃げ43.1%・まくり19.7%・まくり差し15.2%。混戦",
   "lines": [ "…", "…", "…" ] } }
```
- `shape`：逃げの確率から「イン逃げ濃厚（70%以上）／イン有利だが波乱含み（55%以上）／混戦（40%以上）／荒れ模様」
- `start`：選手の平均STを、その枠の平均と比べて「速い／普通／遅め」
- `summary` は**そのまま使える一文**。記事ではこれを膨らませる。**数字を書き換えたり、無い情報を足したりしないこと**
- 作り方：1着確率 × その枠の決まり手の実測（直近1年）。オッズは使っていない

## 4. 実績　`/api/v1/results?days=30`　（無料）
的中率・回収率の実績。サイトの「実績」ページに使う。`days` は1〜365。

- `total`：期間合計。`daily`：日別（新しい順）
- 商品ごとの中身：`plan2`（3連複2点プラン）・`trio4`（3連複4点）・`trifecta4`（3連単4点）・`free_win`（無料枠・単勝1点）・`b2`（B2判定）
- 各項目：`races`・`hits`・`hit_rate`（%）・`spent`（買った額・円）・`returned`（払戻・円）・`return_rate`（%）
- `reference`：長期の検証値（学習に使っていない175日・2,689レース）。**実績と混ぜて表示しないこと**

⚠ 数えているのは**締切前に出した予想だけ**で、外れた日も含みます。回収率は100%未満です。
「必ず儲かる」や、回収率を良く見せる切り取り（当たった日だけ等）の表示はしないでください。実際より有利だと誤解させる表示は法令上の問題になりうるので、表現に迷ったら専門家に確認してください。

## 5. 買い目　`/api/v1/picks?date=YYYY-MM-DD`　（有料）
その日に記録した買い目。レースごとに、ある商品のぶんだけ入る。

| キー | 商品 | 中身 |
|---|---|---|
| `plan2` | 3連複2点プラン（200円） | `picks`：2点（`combo`・`probability`・`hit`・`payout`） |
| `haishin` | 3連複4点＋3連単4点（800円） | `trio`・`trifecta` |
| `free_win` | 無料枠（単勝1点） | `lane`・`racer`・`probability` |
| `b2` | B2判定（単勝1点） | `lane`・`racer`・`class`・`probability` |
| `spot` | 企画枠（場の全レース） | `series`・`trio`・`trifecta` |

`hit` は結果前 `null`、当たり `true`、外れ `false`。`payout` は当たったときの払戻（100円あたり）。

## 6. 選手　`/api/v1/racer?id=登録番号`　（無料）
選手ページに使う。例 `/api/v1/racer?id=4320`。選手一覧は `/api/v1/racers`（直近180日に出走した全選手・勝率順）

- プロフィール：`name`・`kana`・`branch`・`class`・`birth`・`sex`・`age`・`height`・`weight`・`blood`・`period`（期）
- `official`：公式の期別成績／`periods`：直近12期の推移（級別・勝率・2連対率・出走・1着・2着）
- `summary_1y`：直近1年の総合（3連対率・ST順位・事故・優勝/優出/準優）／`titles_since_2022`
- `by_course`：コース別（成績・ST順位・勝ち方・直近5走。1コースは逃げ率と負け方）
- `by_venue`（場別）・`by_grade`（グレード別）・`by_time`（朝/昼/夜）・`by_wave`（波5cm以上/未満）
- `maezuke`：前づけ（枠より内へ）と外へ出た回数・率
- `series_recent`：最近6節（期間・場・開催・着順の並び・優勝/優出/準優出）
- `today`：本日の出走
- `winning_moves`：勝った決まり手の内訳（直近1年）
- `recent`：直近20走（日付・場・R・枠・コース・ST・着順・決まり手）

## 7. 場　`/api/v1/venue?jcd=1〜24`　（無料）
場ページに使う。例 `/api/v1/venue?jcd=5`

- `by_course`：コース別の1着率・2連対率・3連対率（直近1年）
- `kimarite`：決まり手の内訳
- `course1_win_rate_by_month`：1コースの1着率（月別）
- `course1_win_rate_by_race_no`：1コースの1着率（レース番号別）
- `trifecta`：3連単の平均配当・万舟率

## 8. note記事の自動生成用　`/plan2.json?date=YYYY-MM-DD`　（有料）
3連複2点プランだけを、記事を作りやすい形で返す（先に作ったもの）。

**GPTへの指示に必ず入れること**
1. `status` が `"ok"` 以外なら記事を作らない（予想が出ていない日）
2. `closed` が `true` のレースは記事にしない（締切済み）
3. 買い目・確率・的中率の数字は**JSONのまま使い、作ったり丸めたりしない**

---

### 変更の履歴
- 2026-09-21　v1.0 作成（races／race／tenkai／results／picks／racer／venue）
- 2026-09-22　race に `entries[].before`（直前情報）と `conditions`（水面気象）を追加
