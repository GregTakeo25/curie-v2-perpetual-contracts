import { MockContract } from "@eth-optimism/smock"
import { expect } from "chai"
import { parseUnits } from "ethers/lib/utils"
import { waffle } from "hardhat"
import { ClearingHouse, TestERC20, UniswapV3Pool } from "../../typechain"
import { runTxAndReturnEvent } from "../helper/events"
import { toWei } from "../helper/number"
import { encodePriceSqrt } from "../shared/utilities"
import { BaseQuoteOrdering, createClearingHouseFixture } from "./fixtures"

describe.only("ClearingHouse getCostBasis", () => {
    const [admin, maker, taker, taker2] = waffle.provider.getWallets()
    const loadFixture: ReturnType<typeof waffle.createFixtureLoader> = waffle.createFixtureLoader([admin])
    let clearingHouse: ClearingHouse
    let collateral: TestERC20
    let baseToken: TestERC20
    let quoteToken: TestERC20
    let pool: UniswapV3Pool
    let mockedBaseAggregator: MockContract
    let collateralDecimals: number

    beforeEach(async () => {
        const _clearingHouseFixture = await loadFixture(createClearingHouseFixture(BaseQuoteOrdering.BASE_0_QUOTE_1))
        clearingHouse = _clearingHouseFixture.clearingHouse
        collateral = _clearingHouseFixture.USDC
        baseToken = _clearingHouseFixture.baseToken
        quoteToken = _clearingHouseFixture.quoteToken
        mockedBaseAggregator = _clearingHouseFixture.mockedBaseAggregator
        pool = _clearingHouseFixture.pool
        collateralDecimals = await collateral.decimals()

        mockedBaseAggregator.smocked.latestRoundData.will.return.with(async () => {
            return [0, parseUnits("100", 6), 0, 0, 0]
        })

        // add pool
        await clearingHouse.addPool(baseToken.address, 10000)

        // prepare collateral for maker
        const makerCollateralAmount = toWei(100000, collateralDecimals)
        await collateral.mint(maker.address, makerCollateralAmount)
        await collateral.connect(maker).approve(clearingHouse.address, makerCollateralAmount)
        await clearingHouse.connect(maker).deposit(makerCollateralAmount)

        // prepare collateral for taker
        const takerCollateral = toWei(10000, collateralDecimals)
        await collateral.mint(taker.address, takerCollateral)
        await collateral.connect(taker).approve(clearingHouse.address, takerCollateral)
        await clearingHouse.connect(taker).deposit(takerCollateral)
    })

    describe("no swaps", async () => {
        it("taker has no position", async () => {
            expect(await clearingHouse.getPositionSize(taker.address, baseToken.address)).to.eq(toWei(0))
            expect(await clearingHouse.getCostBasis(taker.address)).to.eq(toWei(0))
        })

        it("taker mints quote", async () => {
            const quoteAmount = toWei(100)
            await clearingHouse.connect(taker).mint(quoteToken.address, quoteAmount)
            expect(await clearingHouse.getPositionSize(taker.address, baseToken.address)).to.eq(toWei(0))
            expect(await clearingHouse.getCostBasis(taker.address)).to.eq(toWei(0))
        })

        it.only("maker adds liquidity below price with quote only", async () => {
            console.log("maker adds liquidity below price with quote only")
            await pool.initialize(encodePriceSqrt("200", "1"))

            await clearingHouse.connect(maker).mint(quoteToken.address, toWei(100))
            await clearingHouse.connect(maker).addLiquidity({
                baseToken: baseToken.address,
                base: toWei(0),
                quote: toWei(100),
                lowerTick: 50000, // 148.3760629
                upperTick: 50200, // 151.3733069
            })

            expect(await clearingHouse.getPositionSize(maker.address, baseToken.address)).to.eq(toWei(0))
            // TODO
            console.log("==getCostBasis==")
            console.log("base addr", baseToken.address)
            const tokens = await clearingHouse.getAccountTokens(maker.address)
            console.log(tokens)
            expect(await clearingHouse.getCostBasis(maker.address)).to.eq(toWei(-100))
        })

        it("maker adds liquidity above price with base only", async () => {
            await pool.initialize(encodePriceSqrt("100", "1"))

            await clearingHouse.connect(maker).mint(baseToken.address, toWei(5))

            await clearingHouse.connect(maker).addLiquidity({
                baseToken: baseToken.address,
                base: toWei(2),
                quote: toWei(0),
                lowerTick: 50000, // 148.3760629
                upperTick: 50200, // 151.3733069
            })

            expect(await clearingHouse.getPositionSize(maker.address, baseToken.address)).to.eq(toWei(0))
            expect(await clearingHouse.getCostBasis(maker.address)).to.eq(toWei(0))

            await clearingHouse.connect(maker).addLiquidity({
                baseToken: baseToken.address,
                base: toWei(3),
                quote: toWei(0),
                lowerTick: 49000,
                upperTick: 50400,
            })

            expect(await clearingHouse.getPositionSize(maker.address, baseToken.address)).to.eq(toWei(0))
            expect(await clearingHouse.getCostBasis(maker.address)).to.eq(toWei(0))
        })

        it("maker adds liquidity with both quote and base", async () => {
            await pool.initialize(encodePriceSqrt("100", "1"))

            await clearingHouse.connect(maker).mint(quoteToken.address, toWei(100))
            await clearingHouse.connect(maker).mint(baseToken.address, toWei(1))
            const liquidityChanged = await runTxAndReturnEvent(
                clearingHouse.connect(maker).addLiquidity({
                    baseToken: baseToken.address,
                    base: toWei(1),
                    quote: toWei(100),
                    lowerTick: 0, // $1
                    upperTick: 100000, // $22015.4560485522
                }),
                "LiquidityChanged",
            )
            const addedQuote = liquidityChanged.args.quote // 96504015080269510470
            expect(await clearingHouse.getPositionSize(maker.address, baseToken.address)).to.deep.eq(toWei(0))
            expect(await clearingHouse.getCostBasis(maker.address)).to.deep.eq(0)
        })

        it("", async () => {})
    })
})
