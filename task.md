Project Task: Uniswap v3 Market
Making Bot
1. Objective
The goal of this project is to design, implement, and test a sophisticated market-making bot for a
Uniswap v3 liquidity pool. The bot's primary function is to provide liquidity for the ETH/USDC
pair, using real-time price data from a centralized exchange (CEX) to inform its strategy. This task will test your practical skills in DeFi protocols, real-time data processing, smart
contract interaction, and algorithmic trading logic. A successful implementation will
demonstrate a deep understanding of Uniswap v3's concentrated liquidity mechanics and the
ability to manage a position to avoid offering arbitrage opportunities. 2. Core Assignment
You are tasked with building a bot that performs the following key functions. The
implementation can be in JavaScript/TypeScript (using libraries like ethers.js) or Rust. The
target network for deployment and operation is Arbitrum. Key Functionalities:
1. Live Price Feed Integration
● The bot must subscribe to the Binance WebSocket API to receive real-time price ticks
for the ETH/USDC trading pair. ● It should process this data to maintain an accurate, low-latency mid-price from the
CEX, enabling rebalancing actions as quickly as possible to match Arbitrum's fast block
times. 2. Intelligent Liquidity Provisioning on Uniswap v3
● Using the mid-price from Binance as a reference, the bot must add liquidity to the
corresponding ETH/USDC pool on Uniswap v3. ● Crucially, the bot's core logic must ensure its liquidity position does not
create an arbitrage opportunity. This means the price range (P_lower, P_upper) of
your liquidity must be set strategically around the Binance price. ● This may require providing one-sided liquidity (i.e., only ETH or only USDC) if the
current Uniswap v3 pool price has drifted significantly from the Binance price. Your logic
must be able to determine when and how to do this.

3. Portfolio Rebalancing on a CLOB dex
● As the market price moves, your Uniswap position will accumulate one asset over the
other (e.g., selling ETH for USDC as the price of ETH rises). ● The bot must monitor its own inventory of ETH and USDC. When the portfolio becomes
imbalanced, it must execute swaps on a CLOB dex to rebalance its holdings back to a
target ratio. ● For this task, you will use the Hanji CLOB dex. (docs.hanji.io)
4. Position Management and Re-deployment
● After rebalancing its assets on the CLOB dex, the bot must efficiently update its position
on Uniswap v3. ● This involves removing the old liquidity position and deploying a new one that reflects its
updated portfolio balance and the latest market price from Binance, while still adhering
to the no-arbitrage principle. 3. Technical Requirements
● Language: JavaScript/TypeScript or Rust. ● Python Backtest (Highly Recommended): Develop a backtest in Python to
demonstrate the historical profitability and risk profile of your market-making strategy. This should use historical price data for both Binance and Uniswap v3 to simulate your
bot's logic and produce key performance indicators (KPIs) like Sharpe Ratio, max
drawdown, and total PnL. ● Smart Contracts (Optional but Recommended): While the entire logic can be
executed from a script, creating a simple Solidity helper contract to manage Uniswap
positions (e.g., bundling add/remove liquidity calls) is a significant plus. This
demonstrates an understanding of gas optimization and atomic transactions. ● Code Repository: The final project must be submitted as a link to a public Git
repository (GitHub or GitLab). ● Documentation: A comprehensive README.md file is mandatory. It must include:
○ A clear explanation of your system's architecture. ○ The logic behind your no-arbitrage pricing strategy. ○ Step-by-step instructions on how to configure and run the bot and the backtest. ○ Any assumptions made or trade-offs in your design. 4. Evaluation Criteria
Candidates will be evaluated based on the following:
● Correctness & Functionality: Does the bot successfully execute all the required
functionalities in a logical and effective manner?
● Code Quality: Is the code clean, modular, well-documented, and easy to understand?

● DeFi Concepts: Does the implementation demonstrate a strong grasp of Uniswap v3's
mechanics, including ticks, price ranges, and liquidity management?
● Quantitative Analysis: Is the Python backtest well-constructed, and are its results and
conclusions sound?
● Robustness: How does the bot handle potential errors, such as API downtime, WebSocket disconnections, or failed transactions?
● Documentation: Is the README.md file clear, comprehensive, and professional?
5. Bonus Points
The following features are not required but will be viewed favorably as they demonstrate
advanced skills:
● Containerization: Providing a Dockerfile for easy and reproducible setup. ● Testing: Implementation of unit or integration tests for key components of your logic. ● Configuration: A clean configuration setup (e.g., using .env files) for managing API
keys, wallet private keys, and strategy parameters.

Порядок работ

1. Скелет
Проект на TS, anvil --fork-url для Arbitrum, .env с конфигом.

2. Фид Binance
@bookTicker по WebSocket → mid. Реконнект с backoff, детект протухания.

3. Чтение пула
factory.getPool → slot0(), liquidity(). Декодировать sqrtPriceX96 в цену.
Контрольная точка: печатает расхождение Binance vs пул в bps.

4. Тик-математика
price ↔ tick ↔ sqrtPriceX96, L из сумм и обратно, округление к tickSpacing. Всё на bigint, с юнит-тестами против реального состояния пула.

5. No-arb стратегия
По mid Binance и цене пула считать [pa, pb] со спредом. Определять односторонний случай (ETH-only / USDC-only). Пока dry-run — только лог решений.

6. Исполнение на Uniswap
mint / decreaseLiquidity → collect → burn через NonfungiblePositionManager. За интерфейсом Executor, чтобы dry-run и форк переключались конфигом.

7. Ребалансировка на Hanji
Мониторинг инвентаря, свап до целевой пропорции. Если API недоступно — интерфейс + мок, и честно в README.

8. Полный цикл
Binance двинулся → позиция вне спреда → снять → ребаланс → выставить заново. Плюс живучесть: ретраи транзакций, пауза при протухшем фиде.

9. Бэктест на Python
Данные с data.binance.vision. KPI: Sharpe, max drawdown, PnL. Главный результат — зависимость PnL от ширины диапазона.

10. Упаковка
README (архитектура, вывод no-arb формул, запуск, допущения), Dockerfile, .env.example.