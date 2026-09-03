import { ethers } from 'ethers';
const HELPER = '0xc032b6DFEc3511a00cdE9Ea341D140f4733609De';
const PROXY  = '0x6a6951db3bb99f76a8ccb9f8a8399b613666298b';
const ABI = ['function assembleOrderbookFromOrders(address,bool,uint24) view returns (uint72[],uint128[])'];
const sleep = ms => new Promise(r => setTimeout(r, ms));

for (const url of ['https://mainnet.base.org', 'https://base.llamarpc.com', 'https://base-rpc.publicnode.com']) {
  const p = new ethers.JsonRpcProvider(url);
  const c = new ethers.Contract(HELPER, ABI, p);
  const out = [];
  for (const blk of [49376527, 49452127, 49527727, 49678927]) {
    await sleep(1500);                                  // медленно, по одному
    try {
      const r = await c.assembleOrderbookFromOrders(PROXY, false, 8, { blockTag: blk });
      out.push(`${blk}: ok ${(Number(r[0][0]) / 1e2).toFixed(2)}`);
    } catch (e) {
      out.push(`${blk}: ${(e.shortMessage || e.message).slice(0, 40)}`);
    }
  }
  console.log(url.padEnd(34), out.join(' | '));
}
