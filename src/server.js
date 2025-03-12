require("dotenv").config();
const express = require("express");
const { ethers } = require("ethers");
const cron = require("node-cron");
const fs = require("fs");

const intentNFT_ABI = require("../abis/IntentNFT.json")
const poolsNFT_ABI = require("../abis/PoolsNFT.json")
const grinderAI_ABI = require("../abis/GrinderAI.json")

const app = express();
const PORT = process.env.PORT;

const provider = new ethers.JsonRpcProvider(process.env.RPC_URL);
const grinderWallet = new ethers.Wallet(process.env.GRINDER_PRIVATE_KEY, provider);

const intentNFT = new ethers.Contract(
  process.env.INTENT_NFT_ADDRESS,
  intentNFT_ABI.abi,
  grinderWallet
);

const poolsNFT = new ethers.Contract(
  process.env.POOLS_NFT_ADDRESS,
  poolsNFT_ABI.abi,
  grinderWallet
);

const grinderAI = new ethers.Contract(
    process.env.GRINDER_AI_ADDRESS,
    grinderAI_ABI.abi,
    grinderWallet
)

const OP = {
    LONG_BUY: 0,
    LONG_SELL: 1,
    HEDGE_SELL: 2,
    HEDGE_REBUY: 3,
    REBALANCE: 4,
    INVEST: 5,
    DIVEST: 6
}

// x1.4
let gasMultiplier = {
    numerator: 14n,
    denominator: 10n,
}

let ethPrice; // dinamycally changed via cronjob
let maxTxCostPercentFromActiveCapital = Number(0.0007) // 0.07% from active capital
let maxTxCost = Number(0.05)    // 0.05 USD

let intentsData = []

function loadEthPrice() {
    getEthPriceFromCoinGecko().then((_ethPrice) => {
        ethPrice = _ethPrice
    })
}

function loadIntentsData() {
    try {
        if (fs.existsSync("data/intents.json")) {
            const fileData = fs.readFileSync("data/intents.json", "utf8");
            intentsData = JSON.parse(fileData);
            console.log(`Loaded ${intentsData.length} intents from file.`);
        } else {
            console.error("intents.json not found, using empty dataset.");
            intentsData = [];
        }
    } catch (error) {
        console.error("Error loading intents.json:", error);
        intentsData = [];
    }
}

async function getEthPriceFromCoinGecko() {
    const response = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd");
    if(response.status == 200) {
        const data = await response.json();
        return Number(data.ethereum.usd);
    } else {
        return Number(2700.0);
    }
}

async function getIntent(account) {
    const [ _ , expire, poolIds] = await intentNFT.getIntent(account);
    return { account, expire, poolIds };
}

async function indexAllIntentNFT() {
    try {
        const totalSupply = await intentNFT.totalSupply();
        console.log(`Total IntentNFTs: ${totalSupply}`);

        let allOwnersData = [];
        let intentId = 0
        for (; intentId < totalSupply; intentId++) {
            try {
                const owner = await intentNFT.ownerOf(intentId);
                const { _, expire, poolIds } = await getIntentOf(owner);
                allOwnersData.push({ 
                    intentId: intentId,
                    expire: Number(expire),
                    owner: owner,
                    poolIds: poolIds.map((value) => {return Number(value)})
                });
            } catch (error) {
                console.error(`Error getting owner for poolId ${poolId}:`, error.message);
            }
        }

        fs.writeFileSync("data/intents.json", JSON.stringify(allOwnersData, null, 2));
        console.log("All intents indexed successfully and saved to data/intents.json");

        return true;
    } catch (error) {
        console.error("Error indexing IntentNFT owners:", error);
        return false;
    }
}

async function reindexIntentNFT(intentId) {
    try {
        const index = intentsData.findIndex(intent => intent.intentId === Number(intentId));
        if (index === -1) {
            console.error(`PoolId ${intentId} not found in intents.json`);
            return false;
        }
        const owner = await intentNFT.ownerOf(intentId);
        const { _, expire, poolIds } = await getIntent(owner);
        intentsData[index] = {
            poolId: intentId,
            expire: Number(expire),
            owner: owner,
            poolIds: poolIds.map(poolId => Number(poolId))
        };

        fs.writeFileSync("data/intents.json", JSON.stringify(intentsData, null, 2));
        loadIntentsData()
        console.log(`PoolId ${intentId} successfully reindexed.`);
        return true;
    } catch (error) {
        console.error("Error reindexing IntentNFT:", error);
        return false;
    }
}

async function getPositions(poolId) {
    const positions = await poolsNFT.getPositions(poolId);
    return {
        long: {
            number: Number(positions[0][0]),
            numberMax: Number(positions[0][1]),
            priceMin: positions[0][2].toString(),
            liquidity: positions[0][3].toString(),
            qty: positions[0][4].toString(),
            price: positions[0][5].toString(),
            feeQty: positions[0][6].toString(),
            feePrice: positions[0][7].toString()
        },
        hedge: {
            number: Number(positions[1][0]),
            numberMax: Number(positions[1][1]),
            priceMin: positions[1][2].toString(),
            liquidity: positions[1][3].toString(),
            qty: positions[1][4].toString(),
            price: positions[1][5].toString(),
            feeQty: positions[1][6].toString(),
            feePrice: positions[1][7].toString()
        }
    };
}

function calcMaxTxCost(activeCapital) {

}

function verifyTxCost(gasEstimate, gasPrice, ethPrice, maxTxCost) {
    const _gasEstimate = Number(gasEstimate)// [gasEstimate] = gas
    const _gasPrice = Number(gasPrice)      // [gasPrice]=ETH/gas
    const _ethMultiplier = Number(1e18)     // [ethMultiplier]=1
    const _ethPrice = Number(ethPrice)      // [ethPrice]=USD/ETH
    const _maxTxCost = Number(maxTxCost)    // [maxTxCost]=USD
    console.log("tx cost:", (((_gasEstimate * _gasPrice) / _ethMultiplier) * _ethPrice))
    // gas * (ETH / gas) / 1 * (USD / ETH) = ETH / 1 * USD / ETH = ETH * USD / ETH = USD < USD
    return (((_gasEstimate * _gasPrice) / _ethMultiplier) * _ethPrice) < _maxTxCost
}

async function iterate(poolId) {
    try {
        const positions = await getPositions(poolId);
        const feeData = await provider.getFeeData();
        const gasPrice = feeData.gasPrice;

        async function executeGrindOp(operation) {
            const gasEstimate = await poolsNFT.grindOp.estimateGas(poolId, operation);
            if (verifyTxCost(gasEstimate, gasPrice, ethPrice, maxTxCost)) {
                const gasLimit = Math.ceil(gasEstimate * gasMultiplier.numerator / gasMultiplier.denominator);
                return await poolsNFT.grindOp(poolId, operation, { gasLimit });
            }
            return null;
        }

        if (positions.long.number === 0) {
            return await executeGrindOp(OP.LONG_BUY);
        } 
        if (positions.long.number < positions.long.numberMax) {
            if (await poolsNFT.grindOp.staticCall(poolId, OP.LONG_SELL)) {
                return await executeGrindOp(OP.LONG_SELL);
            }
            if (await poolsNFT.grindOp.staticCall(poolId, OP.LONG_BUY)) {
                return await executeGrindOp(OP.LONG_BUY);
            }
        } else {
            if (positions.hedge.number === 0) {
                if (await poolsNFT.grindOp.staticCall(poolId, OP.LONG_SELL)) {
                    return await executeGrindOp(OP.LONG_SELL);
                }
                if (await poolsNFT.grindOp.staticCall(poolId, OP.HEDGE_SELL)) {
                    return await executeGrindOp(OP.HEDGE_SELL);
                }
            } else {
                if (await poolsNFT.grindOp.staticCall(poolId, OP.HEDGE_REBUY)) {
                    return await executeGrindOp(OP.HEDGE_REBUY);
                }
                if (await poolsNFT.grindOp.staticCall(poolId, OP.HEDGE_SELL)) {
                    return await executeGrindOp(OP.HEDGE_SELL);
                }
            }
        }
        return null;
    } catch (error) {
        console.error("Error iterate: ", error);
        return null;
    }
}

async function iterate2(poolIds) {
    let validatedPoolIds = [];
    let validatedOps = [];

    try {
        const feeData = await provider.getFeeData();
        const gasPrice = feeData.gasPrice;
        const positionsArray = await Promise.all(poolIds.map(poolId => getPositions(poolId)));

        const checks = poolIds.map(async (poolId, index) => {
            const positions = positionsArray[index];

            if (positions.long.number === 0) {
                if (await poolsNFT.grindOp.staticCall(poolId, OP.LONG_BUY)) {
                    validatedPoolIds.push(poolId);
                    validatedOps.push(OP.LONG_BUY);
                    return;
                }
            } else if (positions.long.number < positions.long.numberMax) {
                if (await poolsNFT.grindOp.staticCall(poolId, OP.LONG_SELL)) {
                    validatedPoolIds.push(poolId);
                    validatedOps.push(OP.LONG_SELL);
                    return;
                }
                if (await poolsNFT.grindOp.staticCall(poolId, OP.LONG_BUY)) {
                    validatedPoolIds.push(poolId);
                    validatedOps.push(OP.LONG_BUY);
                    return;
                }
            } else {
                if (positions.hedge.number === 0) {
                    if (await poolsNFT.grindOp.staticCall(poolId, OP.LONG_SELL)) {
                        validatedPoolIds.push(poolId);
                        validatedOps.push(OP.LONG_SELL);
                        return;
                    }
                    if (await poolsNFT.grindOp.staticCall(poolId, OP.HEDGE_SELL)) {
                        validatedPoolIds.push(poolId);
                        validatedOps.push(OP.HEDGE_SELL);
                        return;
                    }
                } else {
                    if (await poolsNFT.grindOp.staticCall(poolId, OP.HEDGE_REBUY)) {
                        validatedPoolIds.push(poolId);
                        validatedOps.push(OP.HEDGE_REBUY);
                        return;
                    }
                    if (await poolsNFT.grindOp.staticCall(poolId, OP.HEDGE_SELL)) {
                        validatedPoolIds.push(poolId);
                        validatedOps.push(OP.HEDGE_SELL);
                        return;
                    }
                }
            }
        });

        await Promise.all(checks);

        if (validatedPoolIds.length > 0) {
            const length = validatedPoolIds.length;
            const gasEstimate = await grinderAI.batchGrindOp.estimateGas(validatedPoolIds, validatedOps);
            
            if (verifyTxCost(gasEstimate, gasPrice, ethPrice, maxTxCost * length)) {
                const isBatchValid = await grinderAI.batchGrindOp.staticCall(validatedPoolIds, validatedOps);
            
                if (isBatchValid) {
                    const gasLimit = gasEstimate * gasMultiplier.numerator / gasMultiplier.denominator;

                    const tx = await grinderAI.batchGrindOp(validatedPoolIds, validatedOps, { gasLimit });
                    console.log("Transaction Hash:", tx.hash);
                } else {
                    console.warn("BatchGrindOp reverted");
                }
            }
        }
    } catch (error) {
        console.error("Error iterate2:", error);
    }
}

async function iterateOf(account) {
    try {
        const intent = intentsData.find(intent => intent.owner.toLowerCase() === account.toLowerCase());
        if (!intent) {
            console.error(`    Intent for account ${account} not found`);
            return;
        }
        const currentTimestampInSeconds = Math.floor(Date.now() / 1000);
        if (intent.expire < currentTimestampInSeconds && intent.expire !== 0) {
            console.error(`    Intent for account ${account} expired`);
            return;
        }
        for (const poolId of intent.poolIds) {
            console.log(`   Iteration poolId ${poolId} for account ${account}`);
            await iterate(poolId);
        }
    } catch (error) {
        console.error("Error in iterateOf:", error);
    }
}

app.post("/iterate/:account", async (req, res) => {
  try {
    const { account } = req.params;
    await iterateOf(account)
    res.json({ success: true, message: "Iteration complete"});
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post("/intents/index", async (req, res) => {
  try {
    const isIndexed = await indexAllIntentNFT();
    res.json({ success: true, isIndexed });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post("/intents/reindex/:intentId", async(req, res) => {
    try {
        const { intentId } = req.params;
        const isReindexed = await reindexIntentNFT(intentId)
        res.json({success: true, isReindexed})
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
})

app.post("/iterate/poolId/:poolId", async (req, res) => {
    try {
        const { poolId } = req.params;
        let tx = await iterate(poolId);
        res.json({success: true, txHash: tx?.hash })
    } catch (error) {
        res.status(500).json({success: false, error: error.message})
    }
})

app.post("/deposit/:account", async (req, res) => {
    // MAKE 
    res.json({})
})

app.get("/intents", async (req, res) => {
    res.json({intentsData})
})

app.get("/ethprice", async (req, res) => {
    res.json({ethPrice})
})

app.listen(PORT, () => {
    loadEthPrice()
    loadIntentsData()
    console.log(`Server running on port ${PORT}`);
});

//////////////////////////////////////////////////////////////////////////

let lastProcessedIntent = 0
let lastProcessedIndex = 0;
let accountsPerIteration = 1;

async function iterateNextAccount() {
    try {
        if (intentsData.length === 0) {
            console.log("No intents available.");
            return;
        }
        const accountData = intentsData[lastProcessedIndex];
        const account = accountData.owner;

        console.log(`   Processing intent for account: ${account}`);
        iterateOf(account);
        lastProcessedIndex = (lastProcessedIndex + 1) % intentsData.length;

    } catch (error) {
        console.error("Error in iterateNextAccount:", error);
    }
}

/// every minute iterate account pools
// cron.schedule("* * * * *", async () => {
//     console.log(`[${new Date().toISOString()}] Running iterateNextAccount`);
//     for(const it = 0; it < accountsPerIteration; it++) {
//         iterateNextAccount();
//     }
// });

async function iterate2NextAccount() {
    try {
        if (intentsData.length === 0) {
            console.log("No intents available.");
            return;
        }
        const accountData = intentsData[lastProcessedIndex];
        const poolIds = accountData.poolIds
        console.log(poolIds)
        console.log(`   Processing intent for poolIds: ${poolIds}`);
        iterate2(poolIds);
        lastProcessedIndex = (lastProcessedIndex + 1) % intentsData.length;

    } catch (error) {
        console.error("Error in iterateNextAccount:", error);
    }
}

cron.schedule("* * * * *", async () => {
    console.log(`[${new Date().toISOString()}] Running iterateNextAccount`);
    for(const it = 0; it < accountsPerIteration; it++) {
        iterate2NextAccount();
    }
});

/// every minute updates ETH price
cron.schedule("* * * * *", async () => {
    ethPrice = await getEthPriceFromCoinGecko()
    // console.log("ETH price: ", ethPrice)
});
