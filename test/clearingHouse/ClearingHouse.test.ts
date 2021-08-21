import { MockContract } from "@eth-optimism/smock"
import { expect } from "chai"
import { parseUnits } from "ethers/lib/utils"
import { waffle } from "hardhat"
import { ClearingHouse, TestClearingHouse, TestERC20, UniswapV3Pool, Vault, VirtualToken } from "../../typechain"
import { deposit } from "../helper/token"
import { encodePriceSqrt } from "../shared/utilities"
import { BaseQuoteOrdering, createClearingHouseFixture } from "./fixtures"

describe("ClearingHouse", () => {
    const EMPTY_ADDRESS = "0x0000000000000000000000000000000000000000"
    const [admin, alice] = waffle.provider.getWallets()
    const loadFixture: ReturnType<typeof waffle.createFixtureLoader> = waffle.createFixtureLoader([admin])
    let clearingHouse: TestClearingHouse
    let vault: Vault
    let collateral: TestERC20
    let baseToken: VirtualToken
    let quoteToken: VirtualToken
    let pool: UniswapV3Pool
    let mockedBaseAggregator: MockContract
    let collateralDecimals: number

    beforeEach(async () => {
        const _clearingHouseFixture = await loadFixture(createClearingHouseFixture(BaseQuoteOrdering.BASE_0_QUOTE_1))
        clearingHouse = _clearingHouseFixture.clearingHouse
        vault = _clearingHouseFixture.vault
        collateral = _clearingHouseFixture.USDC
        baseToken = _clearingHouseFixture.baseToken
        quoteToken = _clearingHouseFixture.quoteToken
        pool = _clearingHouseFixture.pool
        mockedBaseAggregator = _clearingHouseFixture.mockedBaseAggregator
        collateralDecimals = await collateral.decimals()

        mockedBaseAggregator.smocked.latestRoundData.will.return.with(async () => {
            return [0, parseUnits("100", 6), 0, 0, 0]
        })

        // mint
        collateral.mint(admin.address, parseUnits("10000", collateralDecimals))

        const amount = parseUnits("1000", await collateral.decimals())
        await collateral.transfer(alice.address, amount)
        await collateral.connect(alice).approve(clearingHouse.address, amount)
    })

    describe("# freeCollateral", () => {
        it("increase freeCollateral after deposit to vault", async () => {
            const amount = parseUnits("100", await collateral.decimals())

            await deposit(alice, vault, 100, collateral)

            // check collateral status
            expect(await vault.getFreeCollateral(alice.address)).to.deep.eq(amount)

            // check alice balance
            expect(await collateral.balanceOf(alice.address)).to.eq(parseUnits("900", await collateral.decimals()))
        })

        // TODO should we test against potential attack using EIP777?
    })

    describe("# mint", () => {
        beforeEach(async () => {
            // prepare collateral
            await deposit(alice, vault, 1000, collateral)

            // initialize pool
            await pool.initialize(encodePriceSqrt("151.3733069", "1"))
            // add pool after it's initialized
            await clearingHouse.addPool(baseToken.address, 10000)
        })

        // @SAMPLE - mint
        it("alice mint quote and sends an event", async () => {
            // assume imRatio = 0.1
            // alice collateral = 1000, freeCollateral = 10,000, mint 10,000 quote
            const quoteAmount = parseUnits("10000", await quoteToken.decimals())
            await expect(clearingHouse.connect(alice).mint(quoteToken.address, quoteAmount))
                .to.emit(clearingHouse, "Minted")
                .withArgs(alice.address, quoteToken.address, quoteAmount)

            expect(await clearingHouse.getAccountValue(alice.address)).to.eq(parseUnits("1000", collateralDecimals))
            // verify freeCollateral = 1000 - 10,000 * 0.1 = 0
            expect(await vault.getFreeCollateral(alice.address)).to.eq(0)
        })

        it("alice mint base and sends an event", async () => {
            // assume imRatio = 0.1, price = 100
            // alice collateral = 1000, freeCollateral = 10,000, mint 100 base
            const baseAmount = parseUnits("100", await baseToken.decimals())
            await expect(clearingHouse.connect(alice).mint(baseToken.address, baseAmount))
                .to.emit(clearingHouse, "Minted")
                .withArgs(alice.address, baseToken.address, baseAmount)

            expect(await clearingHouse.getAccountValue(alice.address)).to.eq(parseUnits("1000", collateralDecimals))
            // verify freeCollateral = 1,000 - 100 * 100 * 0.1 = 0
            expect(await vault.getFreeCollateral(alice.address)).to.eq(0)
        })

        it("alice mint base twice", async () => {
            // assume imRatio = 0.1, price = 100
            // alice collateral = 1000, freeCollateral = 5,000, mint 50 base
            const baseAmount = parseUnits("50", await baseToken.decimals())
            await expect(clearingHouse.connect(alice).mint(baseToken.address, baseAmount))
                .to.emit(clearingHouse, "Minted")
                .withArgs(alice.address, baseToken.address, baseAmount)
            await expect(clearingHouse.connect(alice).mint(baseToken.address, baseAmount))
                .to.emit(clearingHouse, "Minted")
                .withArgs(alice.address, baseToken.address, baseAmount)

            expect(await clearingHouse.getAccountValue(alice.address)).to.eq(parseUnits("1000", collateralDecimals))
            // verify freeCollateral = 1,000 - 100 * 100 * 0.1 = 0
            expect(await vault.getFreeCollateral(alice.address)).to.eq(0)
        })

        it("alice mint both and sends an event", async () => {
            // assume imRatio = 0.1, price = 100
            // alice collateral = 1000, freeCollateral = 5,000, mint 50 base, 5,000 quote
            const baseAmount = parseUnits("50", await baseToken.decimals())
            const quoteAmount = parseUnits("5000", await quoteToken.decimals())
            await expect(clearingHouse.connect(alice).mint(baseToken.address, baseAmount))
                .to.emit(clearingHouse, "Minted")
                .withArgs(alice.address, baseToken.address, baseAmount)
            await expect(clearingHouse.connect(alice).mint(quoteToken.address, quoteAmount))
                .to.emit(clearingHouse, "Minted")
                .withArgs(alice.address, quoteToken.address, quoteAmount)

            expect(await clearingHouse.getAccountValue(alice.address)).to.eq(parseUnits("1000", collateralDecimals))
            // verify freeCollateral = 1,000 - max(1000 * 10, 10,000) * 0.1 = 0
            expect(await vault.getFreeCollateral(alice.address)).to.eq(0)
        })

        it("alice mint equivalent base and quote", async () => {
            // assume imRatio = 0.1, price = 100
            // alice collateral = 1000, freeCollateral = 10,000, mint 50 base, 5000 quote
            const baseAmount = parseUnits("50", await baseToken.decimals())
            const quoteAmount = parseUnits("5000", await quoteToken.decimals())
            await expect(clearingHouse.connect(alice).mint(baseToken.address, baseAmount))
                .to.emit(clearingHouse, "Minted")
                .withArgs(alice.address, baseToken.address, baseAmount)
            await expect(clearingHouse.connect(alice).mint(quoteToken.address, quoteAmount))
                .to.emit(clearingHouse, "Minted")
                .withArgs(alice.address, quoteToken.address, quoteAmount)

            expect(await clearingHouse.getAccountValue(alice.address)).to.eq(parseUnits("1000", collateralDecimals))
            // verify freeCollateral = 1,000 - (500 * 10 + 5,000) * 0.1 = 0
            expect(await vault.getFreeCollateral(alice.address)).to.eq(0)
        })

        it("alice mint non-equivalent base and quote", async () => {
            // assume imRatio = 0.1, price = 100
            // alice collateral = 1000, freeCollateral = 10,000, mint 60 base, 4000 quote
            const baseAmount = parseUnits("60", await baseToken.decimals())
            const quoteAmount = parseUnits("4000", await quoteToken.decimals())
            await expect(clearingHouse.connect(alice).mint(baseToken.address, baseAmount))
                .to.emit(clearingHouse, "Minted")
                .withArgs(alice.address, baseToken.address, baseAmount)
            await expect(clearingHouse.connect(alice).mint(quoteToken.address, quoteAmount))
                .to.emit(clearingHouse, "Minted")
                .withArgs(alice.address, quoteToken.address, quoteAmount)

            expect(await clearingHouse.getAccountValue(alice.address)).to.eq(
                parseUnits("1000", await collateralDecimals),
            )
            // verify freeCollateral = 1,000 - (600 * 10 + 4,000) * 0.1 = 0
            expect(await vault.getFreeCollateral(alice.address)).to.eq(0)
        })

        // @audit - register is a private method, we don't need to worry about its behavior (@wraecca)
        it("registers each base token once at most", async () => {
            const connectedClearingHouse = clearingHouse.connect(alice)
            // assume imRatio = 0.1, price = 100
            // alice collateral = 1000, freeCollateral = 10,000, mint 5000 quote once and then mint 25 base twice
            const baseAmount = parseUnits("25", await baseToken.decimals())
            const quoteAmount = parseUnits("5000", await quoteToken.decimals())
            await connectedClearingHouse.mint(quoteToken.address, quoteAmount)
            await connectedClearingHouse.mint(baseToken.address, baseAmount)
            await connectedClearingHouse.mint(baseToken.address, baseAmount)

            expect((await clearingHouse.getTokenInfo(alice.address, quoteToken.address)).available).deep.eq(quoteAmount)
            expect((await clearingHouse.getTokenInfo(alice.address, baseToken.address)).available).deep.eq(
                baseAmount.add(baseAmount),
            )
        })

        it("force error, alice mint too many quote", async () => {
            // alice collateral = 1000, freeCollateral = 10,000, mint 10,001 quote
            const quoteAmount = parseUnits("10001", await quoteToken.decimals())
            await expect(clearingHouse.connect(alice).mint(quoteToken.address, quoteAmount)).to.be.revertedWith(
                "CH_NEAV",
            )
        })

        it("force error, alice mint too many base", async () => {
            // alice collateral = 1000, freeCollateral = 10,000, mint 10,001 quote
            const baseAmount = parseUnits("101", await baseToken.decimals())
            await expect(clearingHouse.connect(alice).mint(baseToken.address, baseAmount)).to.be.revertedWith("CH_NEAV")
        })

        it("mint 0 token", async () => {
            await clearingHouse.connect(alice).mint(baseToken.address, 0)
            expect((await clearingHouse.getTokenInfo(alice.address, baseToken.address)).available).eq("0")
        })

        it("force error, alice mint base without specifying baseToken", async () => {
            const baseAmount = parseUnits("100", await baseToken.decimals())
            await expect(clearingHouse.connect(alice).mint(EMPTY_ADDRESS, baseAmount)).to.be.revertedWith("CH_BTNE")
        })

        it("force error, alice mint base without addPool first", async () => {
            const baseAmount = parseUnits("100", await baseToken.decimals())
            // collateral: just a random address
            await expect(clearingHouse.connect(alice).mint(collateral.address, baseAmount)).to.be.revertedWith(
                "CH_BTNE",
            )
        })
    })
})
