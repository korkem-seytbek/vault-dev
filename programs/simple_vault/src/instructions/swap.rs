use anchor_lang::prelude::*;
use anchor_spl::memo::Memo;
use anchor_spl::token::Token;
use anchor_spl::token_2022::Token2022;
use anchor_spl::token_interface::{Mint, TokenAccount};
use raydium_clmm_cpi::{cpi, states::PoolState};

use crate::VaultState;

/// Обмен токенов vault через Raydium CLMM пул.
/// Запускать может только admin, а подписывает обмен vault PDA.
#[derive(Accounts)]
pub struct SwapViaRaydium<'info> {
    pub admin: Signer<'info>,

    #[account(
        seeds = [b"vault", vault_state.token_mint.as_ref()],
        bump = vault_state.bump,
        constraint = vault_state.admin == admin.key() @ crate::VaultError::Unauthorized,
    )]
    pub vault_state: Account<'info, VaultState>,

    /// Откуда списываем, владелец - vault PDA
    #[account(mut, token::authority = vault_state)]
    pub input_token_account: InterfaceAccount<'info, TokenAccount>,

    /// Куда получаем, владелец - vault PDA
    #[account(mut, token::authority = vault_state)]
    pub output_token_account: InterfaceAccount<'info, TokenAccount>,

    /// CHECK: валидируется Raydium
    pub amm_config: UncheckedAccount<'info>,

    #[account(mut)]
    pub pool_state: AccountLoader<'info, PoolState>,

    /// CHECK: валидируется Raydium
    #[account(mut)]
    pub observation_state: UncheckedAccount<'info>,

    #[account(mut)]
    pub input_vault: InterfaceAccount<'info, TokenAccount>,

    #[account(mut)]
    pub output_vault: InterfaceAccount<'info, TokenAccount>,

    pub input_vault_mint: InterfaceAccount<'info, Mint>,
    pub output_vault_mint: InterfaceAccount<'info, Mint>,

    pub token_program: Program<'info, Token>,
    pub token_program_2022: Program<'info, Token2022>,
    pub memo_program: Program<'info, Memo>,

    /// CHECK: проверяется через address = raydium_clmm_cpi::id()
    #[account(address = raydium_clmm_cpi::id())]
    pub clmm_program: UncheckedAccount<'info>,
}

pub fn handler<'a, 'b, 'c: 'info, 'info>(
    ctx: Context<'a, 'b, 'c, 'info, SwapViaRaydium<'info>>,
    amount_in: u64,
    min_amount_out: u64,
    sqrt_price_limit_x64: u128,
) -> Result<()> {
    require!(amount_in > 0, crate::VaultError::ZeroAmount);
    // Минимум 0 означает отсутствие защиты от slippage, поэтому запрещаем
    require!(min_amount_out > 0, crate::VaultError::ZeroAmount);

    let token_mint_key = ctx.accounts.vault_state.token_mint;
    let bump = ctx.accounts.vault_state.bump;
    let vault_seeds: &[&[&[u8]]] = &[&[b"vault", token_mint_key.as_ref(), &[bump]]];

    let balance_before = ctx.accounts.output_token_account.amount;

    let cpi_accounts = cpi::accounts::SwapSingleV2 {
        payer: ctx.accounts.vault_state.to_account_info(),
        amm_config: ctx.accounts.amm_config.to_account_info(),
        pool_state: ctx.accounts.pool_state.to_account_info(),
        input_token_account: ctx.accounts.input_token_account.to_account_info(),
        output_token_account: ctx.accounts.output_token_account.to_account_info(),
        input_vault: ctx.accounts.input_vault.to_account_info(),
        output_vault: ctx.accounts.output_vault.to_account_info(),
        observation_state: ctx.accounts.observation_state.to_account_info(),
        token_program: ctx.accounts.token_program.to_account_info(),
        token_program_2022: ctx.accounts.token_program_2022.to_account_info(),
        memo_program: ctx.accounts.memo_program.to_account_info(),
        input_vault_mint: ctx.accounts.input_vault_mint.to_account_info(),
        output_vault_mint: ctx.accounts.output_vault_mint.to_account_info(),
    };

    // Tick arrays и bitmap extension приходят через remaining_accounts
    let cpi_ctx = CpiContext::new_with_signer(
        ctx.accounts.clmm_program.to_account_info(),
        cpi_accounts,
        vault_seeds,
    )
    .with_remaining_accounts(ctx.remaining_accounts.to_vec());

    // min_amount_out передаётся как other_amount_threshold
    cpi::swap_v2(cpi_ctx, amount_in, min_amount_out, sqrt_price_limit_x64, true)?;

    ctx.accounts.output_token_account.reload()?;
    let received = ctx
        .accounts
        .output_token_account
        .amount
        .checked_sub(balance_before)
        .ok_or(crate::VaultError::MathOverflow)?;

    msg!("Swap: in={}, out={}, min_out={}", amount_in, received, min_amount_out);
    Ok(())
}
