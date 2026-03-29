import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';

const kp = Keypair.generate();

console.log('');
console.log('=== ARBEX — New Solana Wallet ===');
console.log('');
console.log('Public key (wallet address):');
console.log(kp.publicKey.toBase58());
console.log('');
console.log('Private key (base58):');
console.log(bs58.encode(kp.secretKey));
console.log('');
console.log('WARNING: Never share your private key. Add it to .env as WALLET_PRIVATE_KEY.');
console.log('Fund this address with SOL before starting the bot.');
console.log('');
