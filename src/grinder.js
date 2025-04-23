require("dotenv").config()
const { ethers } = require("ethers")
const cron = require("node-cron")

const intentsNFT_json = require("../abis/IntentsNFT.json")
const poolsNFT_json = require("../abis/PoolsNFT.json")
const grinderAI_json = require("../abis/GrinderAI.json")

const INTENTS_NFT_ADDRESS = "0x03afbDE12f4E57dbe551a2b8D7BA0F91239207Af"
const POOLS_NFT_ADDRESS = "0x5B42518423A7CB79A21AF455441831F36FDe823C"
const GRINDER_AI_ADDRESS = "0xf114dEfcAce38689E98A1949DB9b162208810204"

const provider = new ethers.JsonRpcProvider(process.env.RPC_URL)
const grinderWallet = new ethers.Wallet(process.env.GRINDER_PRIVATE_KEY, provider)

const intentsNFT = new ethers.Contract(
    INTENTS_NFT_ADDRESS,
    intentsNFT_json.abi,
    grinderWallet
)

const poolsNFT = new ethers.Contract(
    POOLS_NFT_ADDRESS,
    poolsNFT_json.abi,
    grinderWallet
)

const grinderAI = new ethers.Contract(
    GRINDER_AI_ADDRESS,
    grinderAI_json.abi,
    grinderWallet
)

const OP = {
    LONG_BUY: 0,
    LONG_SELL: 1,
    HEDGE_SELL: 2,
    HEDGE_REBUY: 3,
}

// x1.4
let gasMultiplier = {
    numerator: 14n,
    denominator: 10n,
}

let ethPrice // dinamycally changed via cronjob
let maxTxCost = Number(0.05)    // 0.05 USD

async function getEthPriceFromCoinGecko() {
    const response = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd")
    if(response.status == 200) {
        const data = await response.json()
        return Number(data.ethereum.usd)
    } else {
        return Number(2700.0)
    }
}

async function getTotalIntents() {
    const totalIntents = await intentsNFT.totalIntents()
    return BigInt(totalIntents)
}

async function getIntents(intentIds) {
    const intents = await intentsNFT.getIntents(intentIds)
    return intents.map((intent, index) => ({
        intentId: intentIds[index],
        owner: intent.owner,
        grinds: intent.grinds,
        spentGrinds: intent.spentGrinds,
        unspentGrinds: intent.unspentGrinds,
        poolIds: intent.poolIds,
    }))
}

function verifyTxCost(gasEstimate, gasPrice, ethPrice, maxTxCost) {
    const _gasEstimate = Number(gasEstimate)// [gasEstimate] = gas
    const _gasPrice = Number(gasPrice)      // [gasPrice]=ETH/gas
    const _ethMultiplier = Number(1e18)     // [ethMultiplier]=1
    const _ethPrice = Number(ethPrice)      // [ethPrice]=USD/ETH
    const _maxTxCost = Number(maxTxCost)    // [maxTxCost]=USD
    console.log("tx cost: $", (((_gasEstimate * _gasPrice) / _ethMultiplier) * _ethPrice),)
    // gas * (ETH / gas) / 1 * (USD / ETH) = ETH / 1 * USD / ETH = ETH * USD / ETH = USD < USD
    return (((_gasEstimate * _gasPrice) / _ethMultiplier) * _ethPrice) < _maxTxCost
}

function verifyUnspentGrinds(intent) {
    return intent.unspentGrinds > 0n
}

async function iterate2(poolIds) {
    let validatedPoolIds = []
    let validatedOps = []

    try {
        const feeData = await provider.getFeeData()
        const gasPrice = feeData.gasPrice
        const positionsArray = await poolsNFT.getPositionsBy(poolIds)

        const decodedPositions = positionsArray.map((pair) => {
            const long = Array.from(pair[0])
            const hedge = Array.from(pair[1])
        
            return {
                long: {
                    number: Number(long[0]),
                    numberMax: Number(long[1]),
                    priceMin: long[2].toString(),
                    liquidity: long[3].toString(),
                    qty: long[4].toString(),
                    price: long[5].toString(),
                    feeQty: long[6].toString(),
                    feePrice: long[7].toString()
                },
                hedge: {
                    number: Number(hedge[0]),
                    numberMax: Number(hedge[1]),
                    priceMin: hedge[2].toString(),
                    liquidity: hedge[3].toString(),
                    qty: hedge[4].toString(),
                    price: hedge[5].toString(),
                    feeQty: hedge[6].toString(),
                    feePrice: hedge[7].toString()
                }
            }
        })

        const checks = poolIds.map(async (poolId, index) => {
            const positions = decodedPositions[index]

            if (positions.long.number === 0) {
                if (await poolsNFT.grindOp.staticCall(poolId, OP.LONG_BUY)) {
                    validatedPoolIds.push(poolId)
                    validatedOps.push(OP.LONG_BUY)
                    return
                }
            } else if (positions.long.number < positions.long.numberMax) {
                if (await poolsNFT.grindOp.staticCall(poolId, OP.LONG_SELL)) {
                    validatedPoolIds.push(poolId)
                    validatedOps.push(OP.LONG_SELL)
                    return
                }
                if (await poolsNFT.grindOp.staticCall(poolId, OP.LONG_BUY)) {
                    validatedPoolIds.push(poolId)
                    validatedOps.push(OP.LONG_BUY)
                    return
                }
            } else {
                if (positions.hedge.number === 0) {
                    if (await poolsNFT.grindOp.staticCall(poolId, OP.LONG_SELL)) {
                        validatedPoolIds.push(poolId)
                        validatedOps.push(OP.LONG_SELL)
                        return
                    }
                    if (await poolsNFT.grindOp.staticCall(poolId, OP.HEDGE_SELL)) {
                        validatedPoolIds.push(poolId)
                        validatedOps.push(OP.HEDGE_SELL)
                        return
                    }
                } else {
                    if (await poolsNFT.grindOp.staticCall(poolId, OP.HEDGE_REBUY)) {
                        validatedPoolIds.push(poolId)
                        validatedOps.push(OP.HEDGE_REBUY)
                        return
                    }
                    if (await poolsNFT.grindOp.staticCall(poolId, OP.HEDGE_SELL)) {
                        validatedPoolIds.push(poolId)
                        validatedOps.push(OP.HEDGE_SELL)
                        return
                    }
                }
            }
        })
      
        await Promise.all(checks)

        const length = validatedPoolIds.length
        if (length > 0) {
            console.log("validatedPoolIds: ", validatedPoolIds)
            console.log("validatedOps: ", validatedOps)
            const gasEstimate = await grinderAI.batchGrindOp.estimateGas(validatedPoolIds, validatedOps)

            if (verifyTxCost(gasEstimate, gasPrice, ethPrice, maxTxCost * length)) {
                const isBatchValid = await grinderAI.batchGrindOp.staticCall(validatedPoolIds, validatedOps)
            
                if (isBatchValid) {
                    const gasLimit = gasEstimate * gasMultiplier.numerator / gasMultiplier.denominator

                    const tx = await grinderAI.batchGrindOp(validatedPoolIds, validatedOps, { gasLimit })
                    console.log("Transaction Hash:", tx.hash)
                } else {
                    console.warn("BatchGrindOp reverted")
                }
            }
        }
    } catch (error) {
        console.error("Error iterate2:", error)
    }
}

let intentId = 0n
let intentsPerGrind = 1n

async function bruteForceGrind() {
    try {
        // 0. fetch totalIntents in cron job
        let totalIntents = await getTotalIntents()
        // 1. form intents id
        const intentIds = Array.from({ length: Number(intentsPerGrind) }, (_, i) => Number((intentId + BigInt(i)) % totalIntents))
        // 2. get intents from intentsNFT with provided intentsIds
        const intents = await getIntents(intentIds)
        // for all intent in intents
        await Promise.all(intents.map(async (intent) => { 
            // 3. verify unspent grinds
            if (verifyUnspentGrinds(intent)) {
                // 4. call unpacked poolIds
                
                await iterate2([...intent.poolIds])
            }
        }))
        intentId = (intentId + intentsPerGrind) % totalIntents
    } catch (error) {
        console.error("Error in iterateNextAccount:", error)
    }
}

/// every minute make grind
cron.schedule("* * * * *", async () => {
    console.log(`[${new Date().toISOString()}] Running grind`)
    await bruteForceGrind()
})

/// every minute updates ETH price
cron.schedule("* * * * *", async () => {
    ethPrice = await getEthPriceFromCoinGecko()
})
