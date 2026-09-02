#!/usr/bin/env bash
# Перезапускает форк Arbitrum и заново выдаёт тестовые токены.
# Форк — замороженный снимок, а публичная нода удаляет состояние старых
# блоков, поэтому перед каждой сессией его нужно поднимать заново.
set -e

export PATH="$PATH:$HOME/.foundry/bin"

RPC=http://localhost:8545
UPSTREAM=${UPSTREAM_RPC:-https://arb1.arbitrum.io/rpc}
WALLET=0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266
KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
WETH=0x82aF49447D8a07e3bd95BD0d56f35241523fBab1
USDC=0xaf88d065e77c8cC2239327C5EDb3A432268e5831
USDC_BALANCE_SLOT=9        # найден перебором, см. README

pkill -f "anvil --fork-url" 2>/dev/null || true
sleep 1

# --hardfork shanghai обязателен: в блоках Arbitrum нет полей Cancun,
# иначе anvil падает с "Excess blob gas not set".
nohup anvil --fork-url "$UPSTREAM" --hardfork shanghai --silent > /tmp/anvil.log 2>&1 &

printf 'жду anvil'
for _ in $(seq 1 40); do
  if cast block-number --rpc-url $RPC >/dev/null 2>&1; then echo " — готов"; break; fi
  printf '.'; sleep 1
done

# USDC нельзя «намайнить», поэтому пишем баланс прямо в хранилище.
cast rpc anvil_setStorageAt "$USDC" \
  "$(cast index address $WALLET $USDC_BALANCE_SLOT)" \
  0x000000000000000000000000000000000000000000000000000000003b9aca00 \
  --rpc-url $RPC >/dev/null

# WETH получаем штатно — заворачиваем нативный ETH.
cast send "$WETH" "deposit()" --value 5ether --private-key "$KEY" --rpc-url $RPC >/dev/null

echo "блок      $(cast block-number --rpc-url $RPC)  (сеть: $(cast block-number --rpc-url "$UPSTREAM"))"
echo "кошелёк   $WALLET"
echo "  ETH     $(cast balance $WALLET --rpc-url $RPC --ether)"
echo "  WETH    $(cast call $WETH 'balanceOf(address)(uint256)' $WALLET --rpc-url $RPC | awk '{print $1/1e18}')"
echo "  USDC    $(cast call $USDC 'balanceOf(address)(uint256)' $WALLET --rpc-url $RPC | awk '{print $1/1e6}')"
