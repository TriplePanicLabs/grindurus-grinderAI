# Grindurus Backend

This project is a backend service designed to automate operations with Ethereum-based smart contracts. It periodically updates the ETH price and performs operations on contracts using the `ethers` library and `node-cron` for task scheduling.

## Features

- **ETH Price Updates**: Fetches the latest ETH price from CoinGecko every minute.
- **Smart Contract Operations**: Interacts with `IntentsNFT`, `PoolsNFT`, and `GrinderAI` contracts to process "grinds" and execute operations.
- **Gas Cost Verification**: Ensures that transaction costs remain within a predefined limit before execution.

## Installation

1. Clone the repository:
```bash
   git clone <repository-url>
   cd grindurus-backend
```

2. Install dependencies:
```bash
npm install
```

3. Create a .env file based on .env.example and configure the following variables:
```
RPC_URL=<your RPC URL to blockchain>
GRINDER_PRIVATE_KEY=<your wallet private key>
```

## How It Works

### Key Components

#### Ethereum Connection
- Connects to an Ethereum node using `ethers.JsonRpcProvider`.
- Creates a wallet instance (`grinderWallet`) using the private key from the `.env` file.

#### Smart Contracts
- Interacts with the following contracts:
  - **IntentsNFT**: Manages intents and their associated data.
  - **PoolsNFT**: Handles pool-related operations.
  - **GrinderAI**: Executes batch operations.

#### Periodic Tasks
- **ETH Price Updates**: Fetches the current ETH price in USD from CoinGecko every minute.
- **Grind Operations**: Processes intents and performs operations on pools every minute.

### Workflow

#### ETH Price Updates
- The `getEthPriceFromCoinGecko` function fetches the ETH price from the CoinGecko API.
- Updates the global `ethPrice` variable.

#### Grind Operations
- The `bruteForceGrind` function performs the following steps:
  1. Fetches the total number of intents from the `IntentsNFT` contract.
  2. Retrieves intent data for a subset of intents.
  3. Checks for unspent grinds associated with each intent.
  4. If unspent grinds exist, processes the associated pool IDs using the `iterate2` function.