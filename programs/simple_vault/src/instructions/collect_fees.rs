use anchor_lang::prelude::*;
use raydium_clmm_cpi::cpi;

use super::close_position::CloseRaydiumPosition;

/// Собрать комиссии позиции: decrease_liquidity_v2 с ликвидностью 0.
/// Raydium выплачивает накопленные комиссии вместе с выводом ликвидности,
/// а при liquidity = 0 выплачиваются только комиссии. NFT и позиция остаются.
pub fn collect_handler<'a, 'b, 'c: 'info, 'info>(
    ctx: Context<'a, 'b, 'c, 'info, CloseRaydiumPosition<'info>>,
) -> Result<()> {
    let remaining = ctx.remaining_accounts.to_vec();

    let token_mint_key = ctx.accounts.vault_state.token_mint;
    let bump = ctx.accounts.vault_state.bump;
    let vault_seeds: &[&[&[u8]]] = &[&[b"vault", token_mint_key.as_ref(), &[bump]]];

    let my_token_mint = ctx.accounts.vault_state.token_mint;
    let pool_mint_0 = ctx.accounts.vault_0_mint.key();
    let (recipient_0, recipient_1) = if pool_mint_0 == my_token_mint {
        (
            ctx.accounts.vault_token_account.to_account_info(),
            ctx.accounts.vault_wsol_account.to_account_info(),
        )
    } else {
        (
            ctx.accounts.vault_wsol_account.to_account_info(),
            ctx.accounts.vault_token_account.to_account_info(),
        )
    };

    let accounts = cpi::accounts::DecreaseLiquidityV2 {
        nft_owner: ctx.accounts.vault_state.to_account_info(),
        nft_account: ctx.accounts.position_nft_account.to_account_info(),
        personal_position: ctx.accounts.personal_position.to_account_info(),
        pool_state: ctx.accounts.pool_state.to_account_info(),
        protocol_position: ctx.accounts.protocol_position.to_account_info(),
        token_vault_0: ctx.accounts.token_vault_0.to_account_info(),
        token_vault_1: ctx.accounts.token_vault_1.to_account_info(),
        tick_array_lower: ctx.accounts.tick_array_lower.to_account_info(),
        tick_array_upper: ctx.accounts.tick_array_upper.to_account_info(),
        recipient_token_account_0: recipient_0,
        recipient_token_account_1: recipient_1,
        token_program: ctx.accounts.token_program.to_account_info(),
        token_program_2022: ctx.accounts.token_program_2022.to_account_info(),
        memo_program: ctx.accounts.memo_program.to_account_info(),
        vault_0_mint: ctx.accounts.vault_0_mint.to_account_info(),
        vault_1_mint: ctx.accounts.vault_1_mint.to_account_info(),
    };

    let cpi_ctx = CpiContext::new_with_signer(
        ctx.accounts.clmm_program.to_account_info(),
        accounts,
        vault_seeds,
    )
    .with_remaining_accounts(remaining);

    cpi::decrease_liquidity_v2(cpi_ctx, 0, 0, 0)?;

    msg!("Fees collected");
    Ok(())
}
