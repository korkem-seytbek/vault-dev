# Simple Vault — практика Anchor

Учебный контракт на Anchor 0.31.1 (Solana). Сейчас он делает три вещи:

1. **Vault создан** — админ создаёт vault для SPL-токена. *(неделя 8)*
2. **У каждого пользователя своя «карточка»** — личный аккаунт (PDA) внутри vault. *(неделя 8)*
3. **Депозит и share-токены** — пользователь вносит токены и получает share-токены. *(неделя 9)*

Контракт будет дорабатываться (вывод, Raydium и т.д.), поэтому он намеренно небольшой.

---

## Что делает контракт

```
initialize_vault    создаёт VaultState PDA, vault token account и share mint
create_user_card    создаёт UserCard PDA — личную карточку пользователя в vault
deposit(amount)     переводит токены пользователя в vault → печатает ему shares
```

### `initialize_vault`

Вызывает админ (платит за аккаунты). Создаёт три аккаунта для выбранного `token_mint`:

| Аккаунт | Seeds | Что хранит |
|---|---|---|
| `vault_state` | `["vault", token_mint]` | admin, token_mint, адреса token account и share mint, `total_tokens`, `total_shares`, bump |
| `vault_token_account` | `["vault_tokens", token_mint]` | токен-аккаунт, владелец — vault PDA |
| `share_mint` | `["share_mint", token_mint]` | mint для shares (6 decimals), authority — vault PDA |

### `create_user_card`

Вызывает любой пользователь (платит за свою карточку). Создаёт `UserCard`:

| Поле | Описание |
|---|---|
| `vault` | к какому vault относится карточка |
| `owner` | владелец карточки |
| `deposited` | сколько токенов пользователь внёс всего |
| `shares` | сколько share-токенов он получил |
| `bump` | bump PDA |

Seeds: `["user_card", vault_state, user]` — поэтому у одного пользователя в одном vault
может быть **только одна** карточка. Повторный вызов завершится ошибкой.

### `deposit(amount)`

Пользователь вносит `amount` токенов и получает share-токены — «квитанции» с его долей в vault.
**Депозит возможен только после `create_user_card`** — без карточки инструкция вернёт ошибку.

Что происходит по шагам:

1. Считается, сколько shares положено пользователю.
2. Токены переводятся с токен-аккаунта пользователя в `vault_token_account`.
3. Vault печатает shares на share-аккаунт пользователя (подписывает сам vault PDA).
4. Обновляются `total_tokens` и `total_shares` в vault, а также `deposited` и `shares` в карточке.

**Формула shares:**

```
Первый депозит:       shares = amount                         (1:1)
Последующие депозиты: shares = amount × total_shares / total_tokens
```

Пример: A вносит 100 токенов → получает 100 shares. Потом B вносит 50 → получает 50 shares.
В vault 150 токенов и 150 shares, у A доля 2/3, у B — 1/3.

Ошибки: `ZeroAmount` (сумма 0), `SharesTooSmall` (депозит слишком мал, shares вышло бы 0), `MathOverflow`.

Для вызова `deposit` нужны: токен-аккаунт пользователя (с токенами vault) и share-аккаунт пользователя
(для share mint). В тестах они создаются через `createAccount` из `@solana/spl-token`.

---

## Требования

| Инструмент | Версия | Установка |
|---|---|---|
| Rust | stable | https://rustup.rs |
| Solana CLI | 1.18+ | https://docs.solana.com/cli/install-solana-cli-tools |
| Anchor CLI | 0.31.1 | `cargo install --git https://github.com/coral-xyz/anchor avm --locked && avm install 0.31.1 && avm use 0.31.1` |
| Node.js | 18+ | https://nodejs.org |
| Yarn | any | `npm i -g yarn` |

Rust-зависимости (`anchor-lang`, `anchor-spl` 0.31.1) подтянутся сами при `anchor build`.
JS-зависимости (`@coral-xyz/anchor`, `@solana/web3.js`, `@solana/spl-token`, `mocha`, `chai`, `typescript`) — через `yarn install`.

---

## Быстрый старт

### 1. Установить зависимости

```bash
cd vault-simple
yarn install
```

### 2. Сбилдить контракт

```bash
anchor build
```

Если билдишь **первый раз** (новый keypair):

```bash
anchor keys sync   # обновит declare_id! в lib.rs и Anchor.toml
anchor build       # пересобрать с правильным ID
```

Артефакты в `target/deploy/`:
- `simple_vault.so` — программа
- `simple_vault-keypair.json` — keypair (не коммитить!)

### 3. Настроить Solana CLI на devnet

```bash
solana config set --url devnet
solana address     # твой публичный ключ — запомни его
solana balance
```

### 4. Пополнить кошелёк

Для деплоя нужно ~2 SOL.

```bash
solana airdrop 2   # может не сработать из-за rate limit
```

Если rate limit — используй faucet:
- https://faucet.solana.com (вставь свой адрес)

### 5. Задеплоить

```bash
anchor deploy --provider.cluster devnet
```

### 6. Запустить тесты

```bash
yarn test
```

Ожидаемый вывод:

```
✔ initialize_vault: vault создан
✔ create_user_card: у каждого пользователя своя карточка
✔ create_user_card: вторая карточка для того же пользователя — ошибка
✔ deposit: A вносит 100 токенов → получает 100 shares
✔ deposit: B вносит 50 токенов → получает 50 shares
✔ deposit: без карточки — ошибка
✔ deposit: сумма 0 — ошибка
7 passing
```

---

## Структура проекта

```
vault-simple/
├── programs/simple_vault/src/lib.rs   # контракт
├── tests/vault.ts                     # тесты
├── Anchor.toml
├── Cargo.toml
└── package.json
```

---

## Частые ошибки

| Ошибка | Причина | Решение |
|---|---|---|
| `Insufficient funds` при деплое | мало SOL | пополни кошелёк на devnet |
| `AccountNotInitialized` в тестах | программа не задеплоена или другой ID | `anchor keys sync` → `anchor build` → `anchor deploy` |
| `already in use` при `create_user_card` | у пользователя уже есть карточка | это ожидаемо, карточка одна на пользователя |
| `AccountNotInitialized` (`user_card`) при `deposit` | нет карточки | сначала вызови `create_user_card` |
| `ZeroAmount` | `amount = 0` | вноси сумму больше нуля |
| `SharesTooSmall` | депозит слишком мал относительно vault | увеличь сумму |
| `429 Too Many Requests` | лимит публичного devnet RPC | подожди или возьми свой RPC |

---

## Задания для практики

1. Добавить комиссию 1% на депозит и отправлять её на `fee_wallet`.
2. Добавить минимальный депозит (например, 1 токен).
3. Добавить флаг `paused` в `VaultState`: админ может остановить депозиты.
4. Написать тест: трое пользователей вносят разные суммы, проверить доли по shares.

## Неделя 11: CLMM-пул Raydium (devnet)

Скрипты лежат в папке `week-11-raydium/` (взяты из raydium-sdk-V2-demo и настроены под devnet и мои токены).

| Что | Адрес |
|---|---|
| Токен A (TKA) | `GSvEPH7PfUUWoNGTy1bXZhbiRRkrhkMrEmcWqWk21SSX` |
| Токен B (TKB) | `8qARAvdUES2C9oyHPRt3f12tZZCKiN585xdXb2dq24BG` |
| CLMM-пул | `677MS9VaSqFUGCdUW7MULfxdzpBqgx672RsLhGzn4xet` |
| Позиция (NFT mint) | `ACnhEFPWTub4WUn5ogRQhUjxGo6KjPuhrX4sxpWkxk1s` |

Ссылки в Explorer (devnet):
- [Пул](https://explorer.solana.com/address/677MS9VaSqFUGCdUW7MULfxdzpBqgx672RsLhGzn4xet?cluster=devnet)
- [Позиция](https://explorer.solana.com/address/ACnhEFPWTub4WUn5ogRQhUjxGo6KjPuhrX4sxpWkxk1s?cluster=devnet)

**Параметры пула:** комиссия 0.25%, шаг тиков 60.

**Текущая цена пула:** 1 TKA = 1 TKB (начальная цена 1).

**Диапазон позиции:** цена от 0.8976 до 1.0942 (тики от -1080 до 900). Я задавал 0.9–1.1, SDK округлил границы до шага тиков.

**Почему такой диапазон:** цена пула равна 1, и у двух тестовых токенов нет причин сильно отклоняться от неё, поэтому я взяла коридор около ±10%. Узкий диапазон концентрирует те же деньги на меньшем числе цен, и пока цена внутри него, позиция получает большую долю комиссий, чем при диапазоне «от нуля до бесконечности». Цена: если она выйдет за 0.8976 или 1.0942, позиция превратится целиком в один токен и перестанет зарабатывать, пока цена не вернётся или я не передвину диапазон. Эти адреса понадобятся на неделях 12–13.

## Неделя 12: Swap через Raydium CPI

Vault обменивает свои токены через CLMM-пул Raydium (devnet). Инструкция swap_via_raydium (programs/simple_vault/src/instructions/swap.rs) вызывает swap_v2 Raydium через CPI. Запускать её может только admin, а сам обмен подписывает PDA vault, потому что токены лежат на счетах, владелец которых PDA. Параметр min_amount_out защищает от slippage. Скрипт: scripts/swap.ts.

- Сеть: devnet, программа EpM7JMw19rcwizaARbUgrL2Z6cvv6EMTh9KqJk2iWsEe
- Пул: 677MS9VaSqFUGCdUW7MULfxdzpBqgx672RsLhGzn4xet (TKA/TKB)
- Обмен: 10 TKA -> TKB
- Ожидалось: 9970623, минимум (-1%): 9870916, фактически получено: 9970623 (в минимальных единицах, 6 decimals)

### Результаты
- Успешный обмен: https://explorer.solana.com/tx/XhKLSx5W2SAZNz7WcYg3pJ9z8ctB2FTBvcRqJfPP1wGnL9Nj7gjrRphhcU3hKxdLXN6xNz5sJDkS1Srz6UkiCSQ?cluster=devnet
- Отклонённый из-за slippage (минимум завышен в 1.5 раза, ошибка Raydium TooLittleOutputReceived, код 6018): https://explorer.solana.com/tx/Z7CVRX2fP3igCj1sgjTdUHcXnfAHBRLpnFBgcnEksYreJDs8NSaMrWTzND6n2LfHfzo2Cx6RVeGNKgmtsU6SU1W?cluster=devnet

### Цена пула
До обмена: 1. После обмена: 1.000878 (сдвиг около 0.088%).

### Вопросы для самопроверки
- Slippage: разница между ожидаемой ценой и фактической, потому что цена в пуле успевает измениться. Защита: параметр минимальной суммы на выходе, если пул отдаёт меньше, транзакция откатывается.
- При малой ликвидности около текущей цены обмен быстро проходит текущие тики и уходит в соседние, где цена уже другая, поэтому цена сдвигается сильнее.
- Обмен подписывает программа, потому что токены принадлежат PDA vault, а подписать за PDA может только программа (invoke_signed). Админ лишь разрешает операцию.

## Неделя 13: позиция в CLMM-пуле

Vault сам становится провайдером ликвидности в пуле TKA/TKB (devnet): открывает позицию в выбранном диапазоне цены, собирает комиссии и закрывает позицию. NFT позиции принадлежит PDA vault. Все действия доступны только admin.

Инструкции программы (programs/simple_vault/src/instructions):
- open_raydium_position: открыть позицию, admin задаёт тики диапазона и максимум токенов (amount_0_max, amount_1_max).
- collect_raydium_fees: собрать комиссии (decrease_liquidity_v2 с нулевой ликвидностью, NFT и позиция остаются).
- close_raydium_position: вывести всю ликвидность и сжечь NFT, с минимумами получаемых токенов (amount_0_min, amount_1_min).

Скрипт: scripts/lp.ts (команды open, swaps, collect, close, push, down, status). Обмены для комиссий делаются с другого кошелька (trader).

### Цикл 1: открыть, обмены, собрать комиссии, закрыть
- Диапазон: цена 0.90-1.10 (тики -1080..960, tickSpacing 60), цена пула при открытии 1.0009.
- Внесено в позицию: 5 TKA и 4.379387 TKB.
- 6 обменов по 200 токенов с другого кошелька (по 3 в каждую сторону), цена оставалась в диапазоне (1.0004-1.0184).
- Комиссии собраны: 0.005208 TKA и 0.005208 TKB.
- При закрытии вернулось: 4.976808 TKA и 4.402563 TKB (комиссии уже собраны отдельно).
- Итог для vault: TKA 90 -> 89.982016, TKB 9.970623 -> 9.999007. Выигрыш около 0.0104 токена, это ровно две суммы комиссий: цена почти не изменилась, потерь от смещения цены нет.

Ссылки: открытие https://explorer.solana.com/tx/26fxcQGjYfJcTzTFMTppMqQ2a5wr1Tz3qdvkAzsWTfkXvxCpRe9Qdzx6fU8xZg7pQErR1B3qpkQwfrFa1zFpc7N2?cluster=devnet
обмены:
- https://explorer.solana.com/tx/5FeVuaPHiC1oM68sgFN1g1hKnf2PYwkaSJSGdvAnwD8ae3GHD5RyKVRhxNaSLDKSr4jcmmqSoGPSBK7dA9hXzD1Q?cluster=devnet
- https://explorer.solana.com/tx/y2dywP6SVRsxZGtnMnehWkdvd6Lgu1BRKYrbXDAG4YMK8cjVtVftoE97PPEUgZizTAdCG8ZGXFz4UprSLnPKqWb?cluster=devnet
- https://explorer.solana.com/tx/3Ce1TDKe6Mk4Uush8M3jz2DrpRf8BqUWxUMXmrix37zv4J1tDfAcxvaBh9NVbA23DzbFieAdcLJmiQRUc3u7SzKh?cluster=devnet
- https://explorer.solana.com/tx/7isz3fwvkfi5GbtM3B5rkzQxLo6kpeAvhg2CHnHPUezSWRw81dpLHXJsYDpnHSZ6j2QTZVQ81guSYHy2w6zKjH2?cluster=devnet
- https://explorer.solana.com/tx/2Njhty9w4ZTF5NQwhLzZJ2tmoe2SE9uC8MML4yx2qR8mZcTJafjZ9569EgcmvhWtCRZEcRSAU4ojXRptTArV99Jv?cluster=devnet
- https://explorer.solana.com/tx/4WBTUSiKmj68EwsHz4uPP9um45WhoyeAiM49NahfmzTABJEN9PuXgjhEsMfNsn7hPjFEYNjBL5TQfH4g9Vq7v6f9?cluster=devnet
сбор комиссий https://explorer.solana.com/tx/31DviQmAS4Cq6VKtP8kJzAyXLwBXD1aSj4WhWiFkwY2QoqXzSeCTpRoyQuT4TPeWKPJPipLfkP6sijoroMMGJEvZ?cluster=devnet
закрытие https://explorer.solana.com/tx/2vJihVEAApiUvweo6zLfsNZ9bHf5xZwF2QCCmQCVhyDv1BPDC5Fj5orCmREW1i6wRHLbuK7P8CG33JSK3P7TGcuM?cluster=devnet

### Цикл 2: ребалансировка
1. Открыта позиция в узком диапазоне 0.95-1.05 (тики -540..540) при цене 0.9925: внесено 5 TKA и 6.643579 TKB. Открытие: https://explorer.solana.com/tx/3igBydVnNXTbW9Pa8gX7JwL8SFKY3JumsEnbnnqFSYN28FwXCGAong9Gc3MW8kM8QEpmSTDRP2ZZJWjU1HU7BqLe?cluster=devnet
2. Два обмена по 500 TKA с другого кошелька подняли цену до 1.0813, выше верхней границы 1.05. Позиция вышла из диапазона и перестала зарабатывать комиссии.
3. Позиция закрыта вне диапазона: вернулось 11.814081 TKA и 0 TKB (все токены стали TKA), комиссии за время в диапазоне 0.014315 TKA. Закрытие: https://explorer.solana.com/tx/5pauRQY8Ue4yfyzH9zXZLvzzkNG1iWMoveE6r5maLAoedMTwtkb4RRD4xENZTf49QwA9h1cuZqoYEkvz888vxSc8?cluster=devnet
4. Открыта новая позиция вокруг новой цены 1.0813: диапазон 0.9731-1.1894 (тики -300..1740), внесено 5 TKA и 4.112231 TKB. Открытие: https://explorer.solana.com/tx/4MJq1nhBA5nBYNV3UTKepzB2wQad7F5guyv99wQH6w8bX7mUwB5US8VAoXo1FX9xWpiFCCAXidPEPnfFS3YMN5Vs?cluster=devnet

Цена ребалансировки: если бы токены просто лежали, 5 TKA + 6.643579 TKB стоили бы при цене 1.0813 около 12.18 TKA, а позиция вернула 11.81 TKA вместе с комиссиями, то есть на 0.37 TKA (около 3%) меньше. Пока цена росла, позиция продавала TKB дешевле рынка, комиссии этого не покрыли.

### Вопросы для самопроверки
- Почему соотношение токенов зависит от цены внутри диапазона? Позиция работает как автоматический обмен в пределах диапазона: когда цена растёт, она продаёт токен 0 (TKB) и накапливает токен 1 (TKA), когда падает, наоборот. Ниже нижней границы в позиции только токен 0, выше верхней только токен 1, внутри пропорция плавно меняется. В цикле 2 при цене 0.9925 позиция взяла 5 TKA и 6.64 TKB, а после роста цены осталась только TKA.
- Что будет, если цена выше верхней границы? Позиция целиком конвертируется в токен 1 (у нас TKA), вся ликвидность остаётся вне обменов, комиссии больше не растут. NFT позиции остаётся у vault, пока admin её не закроет или не передвинет.
- Зачем ребалансировка и кто её делает? Чтобы деньги снова работали: позиция вне диапазона не приносит комиссий. Admin закрывает старую позицию и открывает новую вокруг текущей цены. Это стоит денег: комиссии за транзакции и потеря относительно простого хранения токенов, как в цикле 2. В настоящих продуктах это делает автоматический бот.

### Упрощения учебной версии
Пока средства в позиции, пользователи не могут их вывести. Поле total_tokens в состоянии vault не обновляется после swap и открытия позиции, поэтому цена share не отражает комиссии и токены, лежащие в позиции. Для полноценного продукта стоимость vault надо считать по обоим токенам и позиции.
