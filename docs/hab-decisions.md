# HABの設計判断記録（ADR）

[READMEへ](../README.md) · [設計思想](hab-principles.md) · [ロードマップ](hab-roadmap.md)

状態は「採用」「当面不採用」「保留」「未決定」を使います。採用は設計判断であり、本番接続・費用・公開の承認を兼ねません。判断を変更するときは、この表と関連文書・testを更新します。

| ID / 状態      | 判断と理由                                                          | 代替案・限界                                                                                                 |
| -------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| ADR-001 / 採用 | agentの判断を保持し、共通Hubは依頼・進捗・結果を仲介する            | 中央の単一super-agentへの統合は当面不採用。個人文脈を全agentへ複製しない                                     |
| ADR-002 / 採用 | 現本番候補はMac＋SQLite。状態DBは一つ                               | Worker/D1核とmockを移植性のため維持。Sites/D1本番は保留で、現在のpilotでは使わない                           |
| ADR-003 / 採用 | HTTP MCPと外向きMac worker、独立Hermes Runs、durable receiptを使う  | A2Aは初期版で当面不採用。Desktop session/API/authの流用もしない                                              |
| ADR-004 / 採用 | 原子的claim、lease/fence、要求idempotency、監査/outboxで失敗を扱う  | exactly-once配送を保証しない。有限retryと受信側dedup、未知runの照合が必要                                    |
| ADR-005 / 採用 | 固定task、最小scope、並列1、実tool/import境界を最初の受入れにする   | 任意shell・自由入力・自由な宛先・個人データ・自律follow-upは当面不採用                                       |
| ADR-006 / 採用 | Auth0をidentity候補とし、主体/clientを分離。未設定は拒否            | 本番設定・無料feature・client登録方式は未確認。service credentialをuser consentの代わりにしない              |
| ADR-007 / 採用 | 既存Tailscaleの再利用を優先検討し、既存MCPを維持                    | Hubの同host別pathか別8443は未決定。双方に限定code変更とOAuth/client検証が必要。Cloudflare/domainは必須でない |
| ADR-008 / 採用 | 結果取得を最初に、通知はopt-in・固定payload・承認済みcallbackに限定 | Eventsコードは実装済み、実receiver/egress/常駐配送は保留。通知は新taskを作らない                             |
| ADR-009 / 採用 | source/設計はpublic、実設定・秘密・履歴はprivateで管理              | public repoは実agent起動やHub追加公開を許可しない。repoは同一履歴を保持してhiraoku-agent-baseへ改名          |
| ADR-010 / 採用 | 既存jobは元の担当に残す。費用・停止・照合を先に決める               | cronの重複作成、有料fallback、不明admissionの無制限retryは当面不採用                                         |
| ADR-011 / 保留 | Claude Code・Codex・CursorとCuaを限定executor候補にする             | Hub adapter、workspace reservation、権限、費用、result provenanceを検証後に選定                              |
| ADR-012 / 保留 | 競合は設計参考として保存し、部品単位で比較する                      | 導入・置換・migrationは未決定。browser本人sessionによるdot代理操作は初期HAB接続に採用しない                  |

## 次に決める内容

1. Hub外部resource URLとdiscovery route。既存MCPのclient/認証を確認し、既存routeへの干渉がない案を承認する。
2. Auth0 issuer、正確なcallback、主体/clientと最小scope、無料条件、秘密保管とrevocation。
3. 今回のHermes inventoryの実行環境とprivate binding、$0モデル枠、単発停止・回収条件。
4. Dots/Grokの実MCP呼出し・結果取得と、wakeまたはEventsを追加する必要性。

個別のtechnical contractは[Hub内部設計](architecture.md)、[Auth0](auth0-boundary.md)、[import境界](hermes-import-boundary.md)を参照してください。重複する設定表を増やさず、そちらを更新します。
