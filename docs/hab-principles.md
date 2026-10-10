# HABの設計思想

[READMEへ](../README.md) · [役割と機能](hab-roles.md) · [ADR](hab-decisions.md)

## 判断を保つ分業

Personal ContextはDotsに置きます。相談の背景、重要なメールの判断、予定の意味を理解する担当です。Grok BotはCloud Workerとして、既存の情報収集や将来のブラウザ操作・長い仕事を担当します。HermesはLocal Agentとして、Macの開発実験、MCP、Skillsを扱います。ここでのCloud WorkerはGrokの役割であり、Cloudflare WorkersにHubを配置する意味ではありません。

Hubは誰にどの限定仕事を渡せるかを検証し、状態と結果を記録します。各agentの記憶や判断を中央へ移したり、一つの巨大な会話へ統合したりしません。役割分担は目標であり、接続済み機能は[役割表](hab-roles.md)で別に示します。

## 共通Hubと疎結合

共通契約をHTTP MCPと永続キューで表現し、実行環境ごとの差はadapterへ閉じ込めます。Macのworkerは外向きに仕事を受け取ります。agentが停止しても依頼と実行receiptを照合できるようにします。一つのdeploymentでは一つの状態DBを選び、Mac側journalを第二のタスクDBにしません。

担当agent、実行tool、実行環境、workspace、完了条件は別の概念です。Claude Code・Codex・Cursorを使う場合も、その名前を指定しただけでは権限や接続を得られません。実際の主体と実行境界の確認が必要です。

## 最小権限と承認

認証済み主体・client・scope・静的policyから操作と宛先を決めます。引数のagent名、自然言語の「readonly」、proxy headerを認証として扱いません。初期契約は固定payloadで、並列1のHermes実行を基本にします。個人データ、自由な転送先、shell、既存profileの広い権限は追加のレビュー対象です。

sourceのcommit/pushは、外部公開経路、新credential、OAuth grant、常駐process、課金契約や実agent実行の承認を兼ねません。必要な承認は接続先・scope・データ・時間・停止方法を具体化して取ります。

## 重複と無限連鎖を防ぐ

既存cronやconnpass jobは元の担当に残し、Hubで重複作成しません。要求key、原子的claim、lease、fence、run照合を使って二重実行を防ぎます。結果・outbox通知から自動で新依頼を生成しません。配送はat-least-onceなので、受信側もevent IDを重複排除します。

## 費用と失敗を境界にする

Auth0は無料条件の確認を前提にし、有料機能へ自動fallbackしません。既存モデルsubscriptionやログイン成功は「追加料金0」の証明ではありません。利用枠・追加credit・API課金routeが未確認ならmodelを起動しません。

不明な実行、停止失敗、期限切れ、権限変更では止めて照合します。可用性のために認証や隔離を緩めず、未確認を成功に置き換えません。詳細は[処理](hab-workflow.md)と[セキュリティ](hab-security.md)にまとめます。
