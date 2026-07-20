//! Torna reference orderbook (CLOB) with token settlement.
//!
//! A market = two Torna trees (ask/bid) whose authority is a market PDA
//! seeds = [b"book", market_id]. The same PDA owns the base vault (escrow). Ask makers
//! escrow `size` base into the vault at PlaceOrder; a buy taker's Match releases base
//! from the vault to the taker and pays each maker quote, atomically with removing/
//! reducing the order in the book. Cancel refunds the escrow. The book (sorted, parallel)
//! is Torna; ownership + matching + settlement are this program.
//!
//! Order key (32B) mirrors torna_sdk::keys::order_key. Value (40B): maker(32)|size_be(8).
//! Token settlement is SPL-Token CPI (standard plumbing, not the Torna innovation).

use borsh::{BorshDeserialize, BorshSerialize};
use solana_program::{
    account_info::AccountInfo, entrypoint, entrypoint::ProgramResult,
    instruction::{AccountMeta, Instruction},
    program::{get_return_data, invoke, invoke_signed, set_return_data},
    program_error::ProgramError, pubkey::Pubkey,
};

const PLACE: u8 = 0;
const CANCEL: u8 = 1;
const MATCH: u8 = 2;
const PLACE_COLD: u8 = 3;
const INIT_MARKET: u8 = 4;
// --- prediction-market settlement layer (see settlement section at end of file) ---
const RESOLVE: u8 = 5;      // verify TxLINE score proof on-chain -> stamp the winning outcome
const REDEEM: u8 = 6;       // burn winning-side shares -> pay `payout` quote from the vault
const INIT_OUTCOME: u8 = 7; // one-time: bind fixture + outcome spec + NO mint + payout to the market
const MINT_SET: u8 = 8;     // deposit collateral -> mint an equal YES+NO complete set (keeps REDEEM solvent)
// --- TornaFan pick'em / live-leaderboard layer (see the fan section at end of file) ---
const INIT_GAME: u8 = 9;    // create a Hi-Lo game + bind its on-chain leaderboard (Torna) + fixture/oracle
const PLACE_PICK: u8 = 10;  // a player calls Higher/Lower for the current round
const RESOLVE_ROUND: u8 = 11; // verify the round's stat via TxLINE proof, stamp Higher/Lower, advance
const SCORE_ONE: u8 = 12;   // score one player's pick + mirror to the leaderboard (parallel across players)
const INIT_PLAYER: u8 = 13; // one-time: create a player's score/streak state PDA
const ASK: u8 = 0;
const MAXK: usize = 8;

// TornaFan game config PDA [b"game", game_id]: the fixture + the stat we're calling, the txoracle,
// the current round + previous value, the resolved round's Higher/Lower outcome, and the leaderboard
// (torna program + its header, whose authority is the [b"lb", game_id] PDA).
const GAME_MAGIC: u32 = 0x3447_414d; // "MGA4"
const GAME_SIZE: usize = 131;
const G_BUMP: usize = 4;
const G_FIXTURE: usize = 5;        // u64  TxLINE fixtureId
const G_STAT_KEY: usize = 13;      // u32  ScoreStat key we call Hi-Lo on (e.g. corners)
const G_STAT_PERIOD: usize = 17;   // i32  ScoreStat period
const G_ORACLE: usize = 21;        // [u8;32] txoracle
const G_TORNA: usize = 53;         // [u8;32] torna program
const G_LB_HEADER: usize = 85;     // [u8;32] leaderboard tree header (authority = [b"lb", game_id])
const G_ROUND_ID: usize = 117;     // u32  current open round
const G_PREV_VALUE: usize = 121;   // i32  the stat value the current round is called against
const G_LAST_ROUND: usize = 125;   // u32  last resolved round
const G_OUTCOME: usize = 129;      // u8   0=lower, 1=higher, 2=push (for the last resolved round)
const G_LB_BUMP: usize = 130;      // u8   bump of the [b"lb", game_id] leaderboard authority PDA

// Player state PDA [b"pl", game_id, player]: the source of truth for a player's score/streak.
const PLAYER_MAGIC: u32 = 0x344c_5040; // "PL4@"
const PLAYER_SIZE: usize = 20;
const P_BUMP: usize = 4;
const P_SCORE: usize = 5;          // u32
const P_STREAK: usize = 9;         // u16
const P_IN_LB: usize = 11;         // u8  1 once the player has a leaderboard entry
const P_SCORED_ROUND: usize = 12;  // u32 last round this player was scored for (no double-scoring)

// Pick PDA [b"pk", game_id, round_id, player]: one Higher/Lower call.
const PICK_MAGIC: u32 = 0x344b_4350; // "PCK4"
const PICK_SIZE: usize = 6;
const PK_BUMP: usize = 4;
const PK_DIR: usize = 5;           // u8  0=lower, 1=higher

// SPL Token program + token-account layout (mint @0, owner @32, amount @64)
const TOKEN_PROGRAM: Pubkey = solana_program::pubkey!("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const TA_MINT: usize = 0;
const TA_OWNER: usize = 32;
const TOKEN_TRANSFER: u8 = 3;
const TOKEN_MINTTO: u8 = 7;
const TOKEN_BURN: u8 = 8;
// SPL Mint layout: mint_authority COption<Pubkey> = tag(4) + key(32) at offset 0.
const MINT_AUTH_TAG: usize = 0;
const MINT_AUTH_KEY: usize = 4;

// Resolution PDA [b"res", market_id]: the prediction-market half of a market. Separate from cfg so
// the audited init/place/match layout is untouched. It stores the PREDICATE the market settles on
// (the stat legs + comparison, fixed at creation — this binding is the whole security property: the
// prover supplies values, the program supplies the predicate), the NO mint, the per-share payout,
// the TxLINE txoracle program (trust anchor), and — once settled — the winning side + proven values.
const RES_MAGIC: u32 = 0x3453_4552; // "RES4"
const RES_SIZE: usize = 110;
// field offsets within the res PDA
const R_BUMP: usize = 4;
const R_LEG0_KEY: usize = 5;      // u32  TxLINE statKey (period*1000 + base; base 1/2 goals,3/4 yc,5/6 rc,7/8 corners)
const R_LEG0_PERIOD: usize = 9;   // i32  ScoreStat period (100 = game_finalised)
const R_LEG1_KEY: usize = 13;     // u32
const R_LEG1_PERIOD: usize = 17;  // i32
const R_OP: usize = 21;           // u8   binary op for 2 legs: 0=Add, 1=Subtract (ignored if n_legs==1)
const R_CMP: usize = 22;          // u8   comparison: 0=GreaterThan, 1=LessThan, 2=EqualTo
const R_THRESHOLD: usize = 23;    // i32
const R_NLEGS: usize = 27;        // u8   1 or 2
const R_NO_MINT: usize = 28;      // [u8;32]
const R_PAYOUT: usize = 60;       // u64  quote units paid per winning share (== collateral per set)
const R_ORACLE: usize = 68;       // [u8;32] TxLINE txoracle program (owns daily_scores_roots)
const R_RESOLVED: usize = 100;    // u8   0/1
const R_WINNING: usize = 101;     // u8   1=YES predicate held, 0=NO
const R_VAL0: usize = 102;        // i32  proven leg0 value (audit/display)
const R_VAL1: usize = 106;        // i32  proven leg1 value

// TxLINE txoracle on-chain validation. The oracle EXPOSES `validate_stat_v3(payload, strategy)`:
// it verifies the Merkle multiproof against its own daily_scores_roots PDA and returns a bool for
// whether the strategy's predicate holds. We CPI it rather than re-implement Merkle — the oracle
// owns the verification. (Wire types + discriminator: txoracle IDL v1.5.6.)
const SCORES_ROOTS_SEED: &[u8] = b"daily_scores_roots";
const MS_PER_DAY: i64 = 86_400_000;
// Anchor sha256("global:validate_stat_v3")[..8]
const VALIDATE_STAT_V3_DISC: [u8; 8] = [150, 37, 155, 89, 141, 190, 77, 203];

// Market config PDA [b"mkt", market_id]: the canonical mints, vaults, AND book (torna
// program + ask/bid tree headers) of a market. Binding the BOOK (not just the vaults)
// is what stops a taker from settling against a fake tree while draining the real vault.
const MARKET_MAGIC: u32 = 0x344b_544d; // "MTK4"
const TORNA_MAGIC: u32 = 0x3454_4254;  // "TBT4" -- a genuine Torna header
const TORNA_VERSION: u16 = 4;
const H_VERSION: usize = 4;            // torna header: version u16
const H_FLAGS: usize = 6;              // torna header: flags u16 (bit0 = open)
const H_ROOT: usize = 54;             // torna header: root_node_idx u64
const H_HEIGHT: usize = 62;           // torna header: height u32
const H_AUTHORITY: usize = 90;         // torna header: authority pubkey
const H_TREE_UID: usize = 122;        // torna header: tree_uid[16]
const N_TREE_UID: usize = 28;         // node header: tree_uid[16]
const MARKET_SIZE: usize = 229; // magic(4)+cfg_bump(1)+7*32 (base/quote mint, base/quote
                                // vault, torna_program, ask_header, bid_header)

// torna node/header layout (mirrors abi.md)
const NODE_HDR: usize = 44;
const H_VALUE_SIZE: usize = 46;
const H_FANOUT: usize = 48;
const H_LEFTMOST: usize = 66;
const N_KEY_COUNT: usize = 2;
const N_NODE_IDX: usize = 12;
const N_NEXT_LEAF: usize = 20;

entrypoint!(process);

fn rd_u64(d: &[u8], o: usize) -> u64 { u64::from_le_bytes(d[o..o + 8].try_into().unwrap()) }

fn order_key(side: u8, price: u64, slot: u64, maker: &Pubkey, nonce: u64) -> [u8; 32] {
    let p = if side == ASK { price } else { u64::MAX - price };
    let mut k = [0u8; 32];
    k[0..8].copy_from_slice(&p.to_be_bytes());
    k[8..16].copy_from_slice(&slot.to_be_bytes());
    k[16..24].copy_from_slice(&maker.to_bytes()[0..8]);
    k[24..32].copy_from_slice(&nonce.to_be_bytes());
    k
}
fn order_value(maker: &Pubkey, size: u64) -> [u8; 40] {
    let mut v = [0u8; 40];
    v[0..32].copy_from_slice(maker.as_ref());
    v[32..40].copy_from_slice(&size.to_be_bytes());
    v
}
fn price_of(book_side: u8, key: &[u8; 32]) -> u64 {
    let p = u64::from_be_bytes(key[0..8].try_into().unwrap());
    if book_side == ASK { p } else { u64::MAX - p }
}

// ---- Market config (canonical mints + vaults + book) ----
struct Cfg {
    base_mint: [u8; 32], quote_mint: [u8; 32], base_vault: [u8; 32], quote_vault: [u8; 32],
    torna_program: [u8; 32], ask_header: [u8; 32], bid_header: [u8; 32],
}

fn ta_field(a: &AccountInfo, off: usize) -> Result<[u8; 32], ProgramError> {
    if *a.owner != TOKEN_PROGRAM { return Err(ProgramError::IllegalOwner); } // a genuine token account
    let d = a.try_borrow_data()?;
    if d.len() < 72 { return Err(ProgramError::InvalidAccountData); }
    Ok(d[off..off + 32].try_into().unwrap())
}

/// Read + authenticate the market config: program-owned, right magic, and the canonical
/// [b"mkt", market_id] PDA (re-derived from its own stored bump). Returns the config.
fn read_cfg(cfg: &AccountInfo, program_id: &Pubkey, market_id: u64) -> Result<Cfg, ProgramError> {
    if cfg.owner != program_id { return Err(ProgramError::IncorrectProgramId); }
    let d = cfg.try_borrow_data()?;
    if d.len() < MARKET_SIZE || u32::from_le_bytes(d[0..4].try_into().unwrap()) != MARKET_MAGIC {
        return Err(ProgramError::InvalidAccountData);
    }
    let bump = d[4];
    let mid = market_id.to_le_bytes();
    let derived = Pubkey::create_program_address(&[b"mkt", &mid, &[bump]], program_id)
        .map_err(|_| ProgramError::InvalidArgument)?;
    if derived != *cfg.key { return Err(ProgramError::InvalidArgument); }
    Ok(Cfg {
        base_mint: d[5..37].try_into().unwrap(),
        quote_mint: d[37..69].try_into().unwrap(),
        base_vault: d[69..101].try_into().unwrap(),
        quote_vault: d[101..133].try_into().unwrap(),
        torna_program: d[133..165].try_into().unwrap(),
        ask_header: d[165..197].try_into().unwrap(),
        bid_header: d[197..229].try_into().unwrap(),
    })
}

/// Verify the Torna program + the side's tree header match the market config (binds the
/// BOOK to the market, not just the vaults). `header_side`: true=ASK book, false=BID.
fn check_book(cfg: &Cfg, torna: &AccountInfo, header: &AccountInfo, ask_side: bool) -> ProgramResult {
    if torna.key.to_bytes() != cfg.torna_program { return Err(ProgramError::IncorrectProgramId); }
    let want = if ask_side { cfg.ask_header } else { cfg.bid_header };
    if header.key.to_bytes() != want { return Err(ProgramError::InvalidArgument); }
    Ok(())
}

/// InitMarket: create + write the market config PDA after validating the vaults are the
/// book PDA's token accounts of the declared mints. One-time per market.
/// data: [4][market_id u64][book_bump u8][cfg_bump u8][rent u64]
/// accounts: [payer(s,w), market_cfg(w), book_pda, base_mint, quote_mint, base_vault,
///            quote_vault, system, torna_program, ask_header, bid_header]
fn init_market(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    if data.len() < 19 { return Err(ProgramError::InvalidInstructionData); }
    if accounts.len() < 13 { return Err(ProgramError::NotEnoughAccountKeys); }
    let market_id = rd_u64(data, 1);
    let rent = rd_u64(data, 11); // data[9]/[10] (client bumps) are ignored -- we canonicalize
    let (payer, cfg, book) = (&accounts[0], &accounts[1], &accounts[2]);
    let (base_mint, quote_mint, base_vault, quote_vault) =
        (&accounts[3], &accounts[4], &accounts[5], &accounts[6]);
    let (torna, ask_header, bid_header) = (&accounts[8], &accounts[9], &accounts[10]);
    let (ask_root, bid_root) = (&accounts[11], &accounts[12]); // each tree's root leaf (for the clean-state scan)
    if !payer.is_signer { return Err(ProgramError::MissingRequiredSignature); }
    if ask_header.key == bid_header.key { return Err(ProgramError::InvalidArgument); } // distinct books (price-aliasing)
    let mid = market_id.to_le_bytes();

    // Canonical PDAs ONLY. A client-supplied non-canonical bump would let an attacker
    // stand up a SHADOW cfg over an already-funded market's real vaults (round-2 #2).
    let (book_pda, _) = Pubkey::find_program_address(&[b"book", &mid], program_id);
    let (cfg_pda, cfg_bump) = Pubkey::find_program_address(&[b"mkt", &mid], program_id);
    if book_pda != *book.key || cfg_pda != *cfg.key { return Err(ProgramError::InvalidArgument); }
    // vaults must be the book PDA's token accounts of the declared mints
    if ta_field(base_vault, TA_OWNER)? != book.key.to_bytes() || ta_field(base_vault, TA_MINT)? != base_mint.key.to_bytes() {
        return Err(ProgramError::InvalidArgument);
    }
    if ta_field(quote_vault, TA_OWNER)? != book.key.to_bytes() || ta_field(quote_vault, TA_MINT)? != quote_mint.key.to_bytes() {
        return Err(ProgramError::InvalidArgument);
    }
    // Each header must be a GENUINE Torna header that ONLY the book PDA can write:
    // owner==torna, magic, version, NOT open, authority==book PDA, value_size==40. Else an
    // attacker could insert UNESCROWED orders directly via Torna (open/own-authority tree)
    // and drain the vault through cancel/match (round-2 #1).
    for (h, root_leaf) in [(ask_header, ask_root), (bid_header, bid_root)] {
        if h.owner != torna.key { return Err(ProgramError::IncorrectProgramId); }
        let hd = h.try_borrow_data()?;
        if hd.len() < H_TREE_UID + 16 { return Err(ProgramError::InvalidArgument); }
        if u32::from_le_bytes(hd[0..4].try_into().unwrap()) != TORNA_MAGIC { return Err(ProgramError::InvalidArgument); }
        if u16::from_le_bytes(hd[H_VERSION..H_VERSION + 2].try_into().unwrap()) != TORNA_VERSION { return Err(ProgramError::InvalidArgument); }
        if u16::from_le_bytes(hd[H_FLAGS..H_FLAGS + 2].try_into().unwrap()) & 1 != 0 { return Err(ProgramError::InvalidArgument); } // reject OPEN
        if hd[H_AUTHORITY..H_AUTHORITY + 32] != book.key.to_bytes() { return Err(ProgramError::InvalidArgument); }       // book PDA is the sole writer
        let fanout = u16::from_le_bytes(hd[H_FANOUT..H_FANOUT + 2].try_into().unwrap()) as usize;
        if u16::from_le_bytes(hd[H_VALUE_SIZE..H_VALUE_SIZE + 2].try_into().unwrap()) != 40 { return Err(ProgramError::InvalidArgument); }
        // CLEAN STATE: the tree may hold only a 0-size sentinel, never a pre-seeded UNESCROWED
        // order (round-3 #1). Require height <= 1 and, for the single root leaf, every value's
        // size == 0. (Post-init the book PDA is the sole writer, so all real orders are escrowed.)
        let height = u32::from_le_bytes(hd[H_HEIGHT..H_HEIGHT + 4].try_into().unwrap());
        if height > 1 { return Err(ProgramError::InvalidArgument); }
        if height == 1 {
            if root_leaf.owner != torna.key { return Err(ProgramError::IncorrectProgramId); }
            let rld = root_leaf.try_borrow_data()?;
            if rld.len() < NODE_HDR { return Err(ProgramError::InvalidArgument); }
            let root_idx = u64::from_le_bytes(hd[H_ROOT..H_ROOT + 8].try_into().unwrap());
            if u64::from_le_bytes(rld[N_NODE_IDX..N_NODE_IDX + 8].try_into().unwrap()) != root_idx { return Err(ProgramError::InvalidArgument); }
            if rld[N_TREE_UID..N_TREE_UID + 16] != hd[H_TREE_UID..H_TREE_UID + 16] { return Err(ProgramError::InvalidArgument); } // this tree's root
            let voff = NODE_HDR + (fanout + 1) * 32;
            let cnt = u16::from_le_bytes(rld[N_KEY_COUNT..N_KEY_COUNT + 2].try_into().unwrap()) as usize;
            if rld.len() < voff + cnt * 40 { return Err(ProgramError::InvalidArgument); }
            for i in 0..cnt {
                if u64::from_be_bytes(rld[voff + i * 40 + 32..voff + i * 40 + 40].try_into().unwrap()) != 0 {
                    return Err(ProgramError::InvalidArgument); // a pre-seeded order backed by no escrow
                }
            }
        }
    }

    // create the config PDA (program-owned), signed by its seeds
    let mut cd = vec![0u8; 4];
    cd.extend_from_slice(&rent.to_le_bytes());
    cd.extend_from_slice(&(MARKET_SIZE as u64).to_le_bytes());
    cd.extend_from_slice(program_id.as_ref());
    let create = Instruction {
        program_id: Pubkey::default(), // system program
        accounts: vec![AccountMeta::new(*payer.key, true), AccountMeta::new(*cfg.key, true)],
        data: cd,
    };
    invoke_signed(&create, &[payer.clone(), cfg.clone(), accounts[7].clone()],
        &[&[b"mkt", &mid, &[cfg_bump]]])?;

    let mut d = cfg.try_borrow_mut_data()?;
    d[0..4].copy_from_slice(&MARKET_MAGIC.to_le_bytes());
    d[4] = cfg_bump;
    d[5..37].copy_from_slice(base_mint.key.as_ref());
    d[37..69].copy_from_slice(quote_mint.key.as_ref());
    d[69..101].copy_from_slice(base_vault.key.as_ref());
    d[101..133].copy_from_slice(quote_vault.key.as_ref());
    d[133..165].copy_from_slice(torna.key.as_ref());
    d[165..197].copy_from_slice(ask_header.key.as_ref());
    d[197..229].copy_from_slice(bid_header.key.as_ref());
    Ok(())
}

/// SPL-Token Transfer CPI. `seeds` = Some(market PDA seeds) when the vault (PDA-owned)
/// is the source; None when the signer authorizes (e.g. the maker/taker).
fn token_transfer<'a>(
    token_program: &AccountInfo<'a>, source: &AccountInfo<'a>, dest: &AccountInfo<'a>,
    authority: &AccountInfo<'a>, amount: u64, seeds: Option<&[&[&[u8]]]>,
) -> ProgramResult {
    if token_program.key != &TOKEN_PROGRAM { return Err(ProgramError::IncorrectProgramId); }
    let mut data = vec![TOKEN_TRANSFER];
    data.extend_from_slice(&amount.to_le_bytes());
    let metas = vec![
        AccountMeta::new(*source.key, false),
        AccountMeta::new(*dest.key, false),
        AccountMeta::new_readonly(*authority.key, true),
    ];
    let ix = Instruction { program_id: TOKEN_PROGRAM, accounts: metas, data };
    let infos = [source.clone(), dest.clone(), authority.clone(), token_program.clone()];
    match seeds { Some(s) => invoke_signed(&ix, &infos, s), None => invoke(&ix, &infos) }
}

fn process(pid: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    if data.is_empty() { return Err(ProgramError::InvalidInstructionData); }
    match data[0] {
        PLACE => place(pid, accounts, data),
        PLACE_COLD => place_cold(pid, accounts, data),
        CANCEL => cancel(pid, accounts, data),
        MATCH => matcher(pid, accounts, data),
        INIT_MARKET => init_market(pid, accounts, data),
        INIT_OUTCOME => init_outcome(pid, accounts, data),
        MINT_SET => mint_set(pid, accounts, data),
        RESOLVE => resolve(pid, accounts, data),
        REDEEM => redeem(pid, accounts, data),
        INIT_GAME => init_game(pid, accounts, data),
        PLACE_PICK => place_pick(pid, accounts, data),
        RESOLVE_ROUND => resolve_round(pid, accounts, data),
        SCORE_ONE => score_one(pid, accounts, data),
        INIT_PLAYER => init_player(pid, accounts, data),
        _ => Err(ProgramError::InvalidInstructionData),
    }
}

/// PlaceOrder (ask): escrow `size` base into the vault, then insert into the ask book.
/// data: [0][side][price u64][size u64][slot_est u64][nonce u64][market_id u64][bump u8]
/// accounts: [maker(s), market_pda, torna, header, maker_src(w), vault(w),
///            token_program, market_cfg, path(leaf w)]
fn place(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    if data.len() < 43 { return Err(ProgramError::InvalidInstructionData); }
    if accounts.len() < 9 { return Err(ProgramError::NotEnoughAccountKeys); }
    let side = data[1];
    let price = rd_u64(data, 2);
    let size = rd_u64(data, 10);
    let slot_est = rd_u64(data, 18);
    let nonce = rd_u64(data, 26);
    let market_id = rd_u64(data, 34);
    let bump = data[42];
    let maker = &accounts[0];
    if !maker.is_signer { return Err(ProgramError::MissingRequiredSignature); }

    // bind the escrow to the market's canonical vault + mint (per side)
    let cfg = read_cfg(&accounts[7], program_id, market_id)?;
    check_book(&cfg, &accounts[2], &accounts[3], side == ASK)?; // bind the book (program + tree)
    let (want_vault, want_mint) = if side == ASK { (cfg.base_vault, cfg.base_mint) } else { (cfg.quote_vault, cfg.quote_mint) };
    if accounts[5].key.to_bytes() != want_vault { return Err(ProgramError::InvalidArgument); }
    if ta_field(&accounts[4], TA_MINT)? != want_mint { return Err(ProgramError::InvalidArgument); }

    // escrow into the vault (maker authorizes). ASK locks `size` base; BID `price*size` quote.
    if size == 0 || price == 0 { return Err(ProgramError::InvalidArgument); } // no zero/0-price orders (matcher DoS)
    let escrow = if side == ASK { size } else { price.checked_mul(size).ok_or(ProgramError::ArithmeticOverflow)? };
    token_transfer(&accounts[6], &accounts[4], &accounts[5], maker, escrow, None)?;

    let key = order_key(side, price, slot_est, maker.key, nonce);
    let value = order_value(maker.key, size);
    let seeds: &[&[u8]] = &[b"book", &market_id.to_le_bytes(), &[bump]];
    torna_cpi::insert_fast(&accounts[2], &accounts[1], &accounts[3], &accounts[8..], &key, &value, &[seeds])
}

/// PlaceOrderCold: place into a FULL leaf via the cold Insert path (split). Escrow as
/// in `place`; then a dual-signer cold Insert (maker pays spare rent + signs, the market
/// PDA authorizes). Client resolves path+spares via torna_sdk::Tree::cold_plan.
/// data: [3][side][price u64][size u64][slot u64][nonce u64][market_id u64][bump u8]
///        [path_len u8][spare_count u8][rent_node u64][spare_bumps * spare_count]
/// accounts: [maker(s), market_pda, torna, header(w), maker_src(w), vault(w), token,
///            market_cfg, alloc(w), system, path(w)..., spares(w)...]
///            (cfg=7, alloc=8, system=9, path=10..)
fn place_cold(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    if data.len() < 53 { return Err(ProgramError::InvalidInstructionData); }
    let side = data[1];
    let price = rd_u64(data, 2);
    let size = rd_u64(data, 10);
    let slot_est = rd_u64(data, 18);
    let nonce = rd_u64(data, 26);
    let market_id = rd_u64(data, 34);
    let bump = data[42];
    let path_len = data[43] as usize;
    let spare_count = data[44] as usize;
    let rent_node = rd_u64(data, 45);
    if data.len() < 53 + spare_count { return Err(ProgramError::InvalidInstructionData); }
    let spare_bumps = &data[53..53 + spare_count];
    if accounts.len() < 10 + path_len + spare_count { return Err(ProgramError::NotEnoughAccountKeys); }
    let maker = &accounts[0];
    if !maker.is_signer { return Err(ProgramError::MissingRequiredSignature); }

    let cfg = read_cfg(&accounts[7], program_id, market_id)?; // [.. token(6), cfg(7), alloc(8), system(9), path(10)]
    check_book(&cfg, &accounts[2], &accounts[3], side == ASK)?;
    let (want_vault, want_mint) = if side == ASK { (cfg.base_vault, cfg.base_mint) } else { (cfg.quote_vault, cfg.quote_mint) };
    if accounts[5].key.to_bytes() != want_vault { return Err(ProgramError::InvalidArgument); }
    if ta_field(&accounts[4], TA_MINT)? != want_mint { return Err(ProgramError::InvalidArgument); }

    if size == 0 || price == 0 { return Err(ProgramError::InvalidArgument); } // no zero/0-price orders (matcher DoS)
    let escrow = if side == ASK { size } else { price.checked_mul(size).ok_or(ProgramError::ArithmeticOverflow)? };
    token_transfer(&accounts[6], &accounts[4], &accounts[5], maker, escrow, None)?;

    let key = order_key(side, price, slot_est, maker.key, nonce);
    let value = order_value(maker.key, size);
    let path = &accounts[10..10 + path_len];
    let spares = &accounts[10 + path_len..10 + path_len + spare_count];
    let mid = market_id.to_le_bytes();
    let seeds: &[&[u8]] = &[b"book", &mid, &[bump]];
    torna_cpi::insert_cold(&accounts[2], &accounts[1], &accounts[3], maker, &accounts[8], &accounts[9],
        path, spares, &key, &value, rent_node, spare_bumps, &[seeds])
}

/// CancelOrder: refund the escrow, then remove the order.
/// data: [1][key 32][side u8][market_id u64][bump u8]
/// accounts: [maker(s), market_pda, torna, header, vault(w), maker_dst(w),
///            token_program, market_cfg, path(leaf w)]  (vault/dst = base ASK, quote BID)
fn cancel(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    if data.len() < 43 { return Err(ProgramError::InvalidInstructionData); }
    if accounts.len() < 9 { return Err(ProgramError::NotEnoughAccountKeys); }
    let key: [u8; 32] = data[1..33].try_into().unwrap();
    let side = data[33];
    let market_id = rd_u64(data, 34);
    let bump = data[42];
    let maker = &accounts[0];
    if !maker.is_signer { return Err(ProgramError::MissingRequiredSignature); }

    let cfg = read_cfg(&accounts[7], program_id, market_id)?;
    check_book(&cfg, &accounts[2], &accounts[3], side == ASK)?; // bind the book (program + tree)
    let (want_vault, want_mint) = if side == ASK { (cfg.base_vault, cfg.base_mint) } else { (cfg.quote_vault, cfg.quote_mint) };
    if accounts[4].key.to_bytes() != want_vault { return Err(ProgramError::InvalidArgument); }

    // read the order's size + FULL maker from the real (bound) leaf; only the true
    // owner may cancel, and the refund must go to an account they own (not just the
    // right mint) -- the 8-byte key prefix alone is not a sound ownership proof.
    let (size, order_maker) = order_in_leaf(&accounts[3], accounts.last().unwrap(), &key)?;
    if order_maker != maker.key.to_bytes() { return Err(ProgramError::IllegalOwner); }
    if ta_field(&accounts[5], TA_MINT)? != want_mint { return Err(ProgramError::InvalidArgument); }
    if ta_field(&accounts[5], TA_OWNER)? != maker.key.to_bytes() { return Err(ProgramError::IllegalOwner); }

    // refund = what was escrowed: ASK -> size base; BID -> price*size quote
    let refund = if side == ASK { size }
        else { price_of(side, &key).checked_mul(size).ok_or(ProgramError::ArithmeticOverflow)? };

    let mid = market_id.to_le_bytes();
    let seeds: &[&[u8]] = &[b"book", &mid, &[bump]];
    token_transfer(&accounts[6], &accounts[4], &accounts[5], &accounts[1], refund, Some(&[seeds]))?;
    torna_cpi::delete_fast(&accounts[2], &accounts[1], &accounts[3], &accounts[8..], &key, &[seeds])
}

/// Read the size + maker of `key` from a leaf (returns err if absent).
fn order_in_leaf(header: &AccountInfo, leaf: &AccountInfo, key: &[u8; 32]) -> Result<(u64, [u8; 32]), ProgramError> {
    let hd = header.try_borrow_data()?;
    if hd.len() < H_VALUE_SIZE + 2 { return Err(ProgramError::InvalidAccountData); }
    let fanout = u16::from_le_bytes(hd[H_FANOUT..H_FANOUT + 2].try_into().unwrap()) as usize;
    let vs = u16::from_le_bytes(hd[H_VALUE_SIZE..H_VALUE_SIZE + 2].try_into().unwrap()) as usize;
    let ld = leaf.try_borrow_data()?;
    if ld.len() < NODE_HDR + 2 { return Err(ProgramError::InvalidAccountData); }
    let cnt = u16::from_le_bytes(ld[N_KEY_COUNT..N_KEY_COUNT + 2].try_into().unwrap()) as usize;
    let voff = NODE_HDR + (fanout + 1) * 32;
    if ld.len() < voff + cnt * vs { return Err(ProgramError::InvalidAccountData); } // bound the raw reads
    for i in 0..cnt {
        if &ld[NODE_HDR + i * 32..NODE_HDR + i * 32 + 32] == key {
            let vo = voff + i * vs;
            let maker: [u8; 32] = ld[vo..vo + 32].try_into().unwrap();
            let size = u64::from_be_bytes(ld[vo + 32..vo + 40].try_into().unwrap());
            return Ok((size, maker));
        }
    }
    Err(ProgramError::InvalidArgument)
}

/// Match a buy taker against the ask book's best leaf, settling tokens atomically.
/// data: [2][book_side u8][limit u64][size u64][max_fills u8][market_id u64][bump u8]
/// accounts: [taker(s), market_pda, torna, header, vault(w), taker_recv(w),
///            taker_pay(w), token_program, market_cfg, maker_recv[0..K](w), path(leaf w)]
/// return_data: [n][(maker 32, price_be u64, fill_be u64)*n].
fn matcher(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    if data.len() < 30 { return Err(ProgramError::InvalidInstructionData); }
    let book_side = data[1];
    let limit = rd_u64(data, 2);
    let mut remaining = rd_u64(data, 10);
    let max_fills = (data[18] as usize).min(MAXK);
    let market_id = rd_u64(data, 19);
    let bump = data[27];
    let num_leaves = data[28] as usize;
    let height = data[29] as usize;
    if num_leaves == 0 || height == 0 { return Err(ProgramError::InvalidInstructionData); }
    let base = 9 + max_fills; // [8 fixed + market_cfg] then maker_recv[K] then leaf groups
    if accounts.len() < base + num_leaves * height { return Err(ProgramError::NotEnoughAccountKeys); }
    if !accounts[0].is_signer { return Err(ProgramError::MissingRequiredSignature); }
    let header = &accounts[3];

    // bind settlement to the market's canonical vault + mints (per book side)
    let cfg = read_cfg(&accounts[8], program_id, market_id)?;
    check_book(&cfg, &accounts[2], &accounts[3], book_side == ASK)?; // bind the book (program + tree)
    let (want_vault, recv_mint, pay_mint) = if book_side == ASK {
        (cfg.base_vault, cfg.base_mint, cfg.quote_mint)
    } else {
        (cfg.quote_vault, cfg.quote_mint, cfg.base_mint)
    };
    if accounts[4].key.to_bytes() != want_vault { return Err(ProgramError::InvalidArgument); }
    if ta_field(&accounts[5], TA_MINT)? != recv_mint || ta_field(&accounts[6], TA_MINT)? != pay_mint {
        return Err(ProgramError::InvalidArgument);
    }
    let leaf_of = |g: usize| &accounts[base + g * height + (height - 1)]; // the leaf in group g

    let mut keys = [[0u8; 32]; MAXK];
    let mut makers = [[0u8; 32]; MAXK];
    let mut prices = [0u64; MAXK];
    let mut fills = [0u64; MAXK];
    let mut new_sizes = [0u64; MAXK];
    let mut grp = [0u8; MAXK]; // which leaf group each fill is in (its path for phase 2)
    let mut nf = 0usize;
    {
        let hd = header.try_borrow_data()?;
        if hd.len() < H_TREE_UID + 16 { return Err(ProgramError::InvalidAccountData); }
        let huid = &hd[H_TREE_UID..H_TREE_UID + 16]; // bind every swept leaf to THIS tree (defense-in-depth)
        let fanout = u16::from_le_bytes(hd[H_FANOUT..H_FANOUT + 2].try_into().unwrap()) as usize;
        let vs = u16::from_le_bytes(hd[H_VALUE_SIZE..H_VALUE_SIZE + 2].try_into().unwrap()) as usize;
        if vs < 40 { return Err(ProgramError::InvalidAccountData); }
        let voff = NODE_HDR + (fanout + 1) * 32;
        if num_leaves > 64 { return Err(ProgramError::InvalidInstructionData); }
        let mut seen = [0u64; 64]; let mut nseen = 0usize; // dedup: a real next_leaf chain never revisits
        // leaf 0 must be the book's best (leftmost); each next must chain from the prev
        let mut expected = u64::from_le_bytes(hd[H_LEFTMOST..H_LEFTMOST + 8].try_into().unwrap());
        'sweep: for g in 0..num_leaves {
            if remaining == 0 || nf >= max_fills { break; }
            // each swept leaf MUST be a genuine Torna node (no forged byte accounts to fake the
            // chain) and MUST be distinct -- else the SAME order settles twice -> vault drain.
            if leaf_of(g).owner != accounts[2].key { return Err(ProgramError::IllegalOwner); }
            let ld = leaf_of(g).try_borrow_data()?;
            if ld.len() < NODE_HDR { return Err(ProgramError::InvalidAccountData); }
            if u64::from_le_bytes(ld[N_NODE_IDX..N_NODE_IDX + 8].try_into().unwrap()) != expected {
                return Err(ProgramError::InvalidArgument); // wrong/out-of-order leaf
            }
            if seen[..nseen].contains(&expected) { return Err(ProgramError::InvalidArgument); } // duplicate leaf
            seen[nseen] = expected; nseen += 1;
            if ld[0] != 1 || ld[N_TREE_UID..N_TREE_UID + 16] != *huid { return Err(ProgramError::InvalidArgument); } // a leaf of THIS tree
            let cnt = u16::from_le_bytes(ld[N_KEY_COUNT..N_KEY_COUNT + 2].try_into().unwrap()) as usize;
            if ld.len() < voff + cnt * vs { return Err(ProgramError::InvalidAccountData); } // bound the raw reads
            for i in 0..cnt {
                if remaining == 0 || nf >= max_fills { break; }
                let key: [u8; 32] = ld[NODE_HDR + i * 32..NODE_HDR + i * 32 + 32].try_into().unwrap();
                let price = price_of(book_side, &key);
                let cross = if book_side == ASK { price <= limit } else { price >= limit };
                if !cross { break 'sweep; } // globally sorted -> first non-crosser ends it
                let vo = voff + i * vs;
                let resting = u64::from_be_bytes(ld[vo + 32..vo + 40].try_into().unwrap());
                if resting == 0 { continue; } // skip 0-size (the sentinel / any stray) -- no slot, no delete
                let fill = remaining.min(resting);
                keys[nf] = key;
                makers[nf].copy_from_slice(&ld[vo..vo + 32]);
                prices[nf] = price; fills[nf] = fill; new_sizes[nf] = resting - fill; grp[nf] = g as u8;
                remaining -= fill; nf += 1;
            }
            expected = u64::from_le_bytes(ld[N_NEXT_LEAF..N_NEXT_LEAF + 8].try_into().unwrap());
        }
    }

    let mid = market_id.to_le_bytes();
    let seeds: &[&[u8]] = &[b"book", &mid, &[bump]];
    for j in 0..nf {
        // settle. ASK book (taker buy): release `fill` base from vault -> taker, collect
        // `price*fill` quote taker -> maker. BID book (taker sell): mirror. The order is
        // mutated through its OWN leaf-group path (the sweep may span leaves).
        let maker_recv = &accounts[9 + j];
        {
            let md = maker_recv.try_borrow_data()?;
            if md.len() < 72 || md[TA_OWNER..TA_OWNER + 32] != makers[j] { return Err(ProgramError::IllegalOwner); }
            if md[TA_MINT..TA_MINT + 32] != pay_mint { return Err(ProgramError::InvalidArgument); } // maker must be paid the canonical mint
        }
        let quote_amt = prices[j].checked_mul(fills[j]).ok_or(ProgramError::ArithmeticOverflow)?;
        let (release, collect) = if book_side == ASK { (fills[j], quote_amt) } else { (quote_amt, fills[j]) };
        token_transfer(&accounts[7], &accounts[4], &accounts[5], &accounts[1], release, Some(&[seeds]))?;
        token_transfer(&accounts[7], &accounts[6], maker_recv, &accounts[0], collect, None)?;
        let g = grp[j] as usize;
        let path = &accounts[base + g * height..base + (g + 1) * height];
        if new_sizes[j] == 0 {
            torna_cpi::delete_fast(&accounts[2], &accounts[1], header, path, &keys[j], &[seeds])?;
        } else {
            let m = Pubkey::new_from_array(makers[j]);
            let v = order_value(&m, new_sizes[j]);
            torna_cpi::update_fast(&accounts[2], &accounts[1], header, path, &keys[j], &v, &[seeds])?;
        }
    }

    let mut out = Vec::with_capacity(1 + nf * 48);
    out.push(nf as u8);
    for j in 0..nf {
        out.extend_from_slice(&makers[j]);
        out.extend_from_slice(&prices[j].to_be_bytes());
        out.extend_from_slice(&fills[j].to_be_bytes());
    }
    set_return_data(&out);
    Ok(())
}

// ============================================================================================
// Prediction-market settlement layer
// --------------------------------------------------------------------------------------------
// A market becomes a prediction market once INIT_OUTCOME binds it to a TxLINE fixture + the
// outcome YES pays on. YES is the CLOB `base` mint; NO is a second mint; both are minted only by
// MINT_SET against `payout` quote of collateral per set — so the quote vault always holds exactly
// enough to redeem every winning share. RESOLVE settles the market trustlessly: it verifies a
// TxLINE score Merkle proof against the on-chain daily_scores_roots PDA (owned by the TxLINE
// program), so the outcome comes from TxLINE's published root, not from whoever calls RESOLVE.
// REDEEM then burns winning-side shares for quote; losing shares are worth 0.
// ============================================================================================

/// SPL-Token MintTo / Burn CPI, mirroring `token_transfer`. `seeds` = Some(book PDA seeds) when the
/// book PDA is the mint/burn authority; None when a user signs.
fn token_op<'a>(
    op: u8, token_program: &AccountInfo<'a>, a0: &AccountInfo<'a>, a1: &AccountInfo<'a>,
    authority: &AccountInfo<'a>, amount: u64, seeds: Option<&[&[&[u8]]]>,
) -> ProgramResult {
    if token_program.key != &TOKEN_PROGRAM { return Err(ProgramError::IncorrectProgramId); }
    let mut data = vec![op];
    data.extend_from_slice(&amount.to_le_bytes());
    // MintTo: [mint(w), dest(w), authority(s)]  Burn: [account(w), mint(w), authority(s)]
    let metas = vec![
        AccountMeta::new(*a0.key, false),
        AccountMeta::new(*a1.key, false),
        AccountMeta::new_readonly(*authority.key, true),
    ];
    let ix = Instruction { program_id: TOKEN_PROGRAM, accounts: metas, data };
    let infos = [a0.clone(), a1.clone(), authority.clone(), token_program.clone()];
    match seeds { Some(s) => invoke_signed(&ix, &infos, s), None => invoke(&ix, &infos) }
}

/// Return a mint's authority pubkey, requiring it to be Some (COption tag == 1). A None authority
/// (fixed supply) would make MINT_SET impossible, so reject it here.
fn mint_authority(mint: &AccountInfo) -> Result<[u8; 32], ProgramError> {
    if *mint.owner != TOKEN_PROGRAM { return Err(ProgramError::IllegalOwner); }
    let d = mint.try_borrow_data()?;
    if d.len() < MINT_AUTH_KEY + 32 { return Err(ProgramError::InvalidAccountData); }
    if d[MINT_AUTH_TAG..MINT_AUTH_TAG + 4] != [1, 0, 0, 0] { return Err(ProgramError::InvalidArgument); }
    Ok(d[MINT_AUTH_KEY..MINT_AUTH_KEY + 32].try_into().unwrap())
}

/// Re-derive + check the book PDA for a market, returning its canonical seeds' bump.
fn check_book_pda(program_id: &Pubkey, book: &AccountInfo, market_id: u64) -> Result<u8, ProgramError> {
    let mid = market_id.to_le_bytes();
    let (pda, bump) = Pubkey::find_program_address(&[b"book", &mid], program_id);
    if pda != *book.key { return Err(ProgramError::InvalidArgument); }
    Ok(bump)
}

/// Validate the resolution PDA is program-owned, right magic, and the canonical [b"res", market_id]
/// PDA (from its own stored bump). Leaves the data for the caller to borrow.
fn check_res(res: &AccountInfo, program_id: &Pubkey, market_id: u64) -> ProgramResult {
    if res.owner != program_id { return Err(ProgramError::IncorrectProgramId); }
    let d = res.try_borrow_data()?;
    if d.len() < RES_SIZE || u32::from_le_bytes(d[0..4].try_into().unwrap()) != RES_MAGIC {
        return Err(ProgramError::InvalidAccountData);
    }
    let bump = d[R_BUMP];
    let mid = market_id.to_le_bytes();
    let derived = Pubkey::create_program_address(&[b"res", &mid, &[bump]], program_id)
        .map_err(|_| ProgramError::InvalidArgument)?;
    if derived != *res.key { return Err(ProgramError::InvalidArgument); }
    Ok(())
}

// ---- txoracle validate_stat_v3 wire types (byte-identical to txoracle IDL v1.5.6) ----
// We DESERIALIZE the caller's payload (to bind its leaves to our predicate) and SERIALIZE the
// strategy we build from our own stored predicate. Borsh matches Anchor's serialization.

#[derive(BorshDeserialize, BorshSerialize, Clone)]
struct ProofNode { hash: [u8; 32], is_right_sibling: bool }
#[derive(BorshDeserialize, BorshSerialize, Clone)]
struct ScoreStat { key: u32, value: i32, period: i32 }
#[derive(BorshDeserialize, BorshSerialize, Clone)]
struct StatLeaf { stat: ScoreStat, stat_proof: Vec<ProofNode> }
#[derive(BorshDeserialize, BorshSerialize, Clone)]
struct ScoresUpdateStats { update_count: i32, min_timestamp: i64, max_timestamp: i64 }
#[derive(BorshDeserialize, BorshSerialize, Clone)]
struct ScoresBatchSummary { fixture_id: i64, update_stats: ScoresUpdateStats, events_sub_tree_root: [u8; 32] }
#[derive(BorshDeserialize, BorshSerialize, Clone)]
struct StatValidationInputV3 {
    ts: i64,
    fixture_summary: ScoresBatchSummary,
    fixture_proof: Vec<ProofNode>,
    main_tree_proof: Vec<ProofNode>,
    event_stat_root: [u8; 32],
    leaves: Vec<StatLeaf>,
    multiproof_hashes: Vec<ProofNode>,
    leaf_indices: Vec<u32>,
}
#[derive(BorshSerialize)] enum Comparison { GreaterThan, LessThan, EqualTo }
#[derive(BorshSerialize)] enum BinaryExpression { Add, Subtract }
#[derive(BorshSerialize)] struct TraderPredicate { threshold: i32, comparison: Comparison }
#[derive(BorshSerialize)] struct GeometricTarget { stat_index: u8, prediction: i32 }
#[derive(BorshSerialize)]
enum StatPredicate {
    Single { index: u8, predicate: TraderPredicate },
    Binary { index_a: u8, index_b: u8, op: BinaryExpression, predicate: TraderPredicate },
}
#[derive(BorshSerialize)]
struct NDimensionalStrategy {
    geometric_targets: Vec<GeometricTarget>,
    distance_predicate: Option<TraderPredicate>,
    discrete_predicates: Vec<StatPredicate>,
}

fn comparison(c: u8) -> Result<Comparison, ProgramError> {
    Ok(match c { 0 => Comparison::GreaterThan, 1 => Comparison::LessThan, 2 => Comparison::EqualTo,
        _ => return Err(ProgramError::InvalidInstructionData) })
}

/// Build the strategy from the market's STORED predicate (never from the caller). One discrete
/// predicate over the market's leg(s), AND-combined — the shape TxLINE's coverage rule requires
/// (each proven leg referenced exactly once).
fn build_strategy(n_legs: u8, op: u8, cmp: u8, threshold: i32) -> Result<NDimensionalStrategy, ProgramError> {
    let predicate = TraderPredicate { threshold, comparison: comparison(cmp)? };
    let discrete = if n_legs == 2 {
        let op = match op { 0 => BinaryExpression::Add, 1 => BinaryExpression::Subtract,
            _ => return Err(ProgramError::InvalidInstructionData) };
        vec![StatPredicate::Binary { index_a: 0, index_b: 1, op, predicate }]
    } else {
        vec![StatPredicate::Single { index: 0, predicate }]
    };
    Ok(NDimensionalStrategy { geometric_targets: vec![], distance_predicate: None, discrete_predicates: discrete })
}

/// CPI txoracle `validate_stat_v3(payload, strategy)` and decode the returned bool. `payload_bytes`
/// is the caller's already-borsh-serialized StatValidationInputV3; `strategy` is ours.
fn cpi_validate_stat_v3<'a>(
    oracle: &AccountInfo<'a>, roots: &AccountInfo<'a>, payload_bytes: &[u8], strategy: &NDimensionalStrategy,
) -> Result<bool, ProgramError> {
    let mut data = Vec::with_capacity(8 + payload_bytes.len() + 64);
    data.extend_from_slice(&VALIDATE_STAT_V3_DISC);
    data.extend_from_slice(payload_bytes);          // payload (values + merkle material) from caller
    strategy.serialize(&mut data).map_err(|_| ProgramError::InvalidInstructionData)?; // predicate from us
    let ix = Instruction {
        program_id: *oracle.key,
        accounts: vec![AccountMeta::new_readonly(*roots.key, false)],
        data,
    };
    invoke(&ix, &[roots.clone(), oracle.clone()])?; // a forged proof makes the oracle ERROR here
    let (ret_prog, ret) = get_return_data().ok_or(ProgramError::InvalidAccountData)?;
    if ret_prog != *oracle.key { return Err(ProgramError::IncorrectProgramId); }
    Ok(ret.first().copied().unwrap_or(0) == 1)
}

/// InitOutcome: bind the settlement PREDICATE + NO mint + payout + txoracle to a market (one-time).
/// The predicate (stat legs + comparison) is fixed here and never taken from the settler. Requires
/// the book PDA to be the mint authority of BOTH YES(base) and NO so MINT_SET is the only minter.
/// data: [7][market_id u64][res_bump u8][leg0_key u32][leg0_period i32][leg1_key u32][leg1_period i32]
///        [op u8][comparison u8][threshold i32][n_legs u8][payout u64][rent u64][oracle_program 32]
/// accounts: [authority(s,w), res(w), market_cfg, base_mint, no_mint, book_pda, system]
fn init_outcome(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    if data.len() < 81 { return Err(ProgramError::InvalidInstructionData); }
    if accounts.len() < 7 { return Err(ProgramError::NotEnoughAccountKeys); }
    let market_id = rd_u64(data, 1);
    let leg0_key = u32::from_le_bytes(data[10..14].try_into().unwrap());
    let leg0_period = i32::from_le_bytes(data[14..18].try_into().unwrap());
    let leg1_key = u32::from_le_bytes(data[18..22].try_into().unwrap());
    let leg1_period = i32::from_le_bytes(data[22..26].try_into().unwrap());
    let op = data[26];
    let cmp = data[27];
    let threshold = i32::from_le_bytes(data[28..32].try_into().unwrap());
    let n_legs = data[32];
    let payout = rd_u64(data, 33);
    let rent = rd_u64(data, 41);
    let oracle_program: [u8; 32] = data[49..81].try_into().unwrap();
    let (authority, res, cfg_ai) = (&accounts[0], &accounts[1], &accounts[2]);
    let (base_mint, no_mint, book) = (&accounts[3], &accounts[4], &accounts[5]);
    if !authority.is_signer { return Err(ProgramError::MissingRequiredSignature); }
    if payout == 0 || (n_legs != 1 && n_legs != 2) || cmp > 2 { return Err(ProgramError::InvalidArgument); }

    let cfg = read_cfg(cfg_ai, program_id, market_id)?;
    check_book_pda(program_id, book, market_id)?;
    if base_mint.key.to_bytes() != cfg.base_mint { return Err(ProgramError::InvalidArgument); } // YES == CLOB base
    if no_mint.key == base_mint.key { return Err(ProgramError::InvalidArgument); }
    if mint_authority(base_mint)? != book.key.to_bytes() { return Err(ProgramError::InvalidArgument); }
    if mint_authority(no_mint)? != book.key.to_bytes() { return Err(ProgramError::InvalidArgument); }

    // create the res PDA (program-owned), signed by its seeds
    let mid = market_id.to_le_bytes();
    let (res_pda, res_bump) = Pubkey::find_program_address(&[b"res", &mid], program_id);
    if res_pda != *res.key { return Err(ProgramError::InvalidArgument); }
    let mut cd = vec![0u8; 4];
    cd.extend_from_slice(&rent.to_le_bytes());
    cd.extend_from_slice(&(RES_SIZE as u64).to_le_bytes());
    cd.extend_from_slice(program_id.as_ref());
    let create = Instruction {
        program_id: Pubkey::default(),
        accounts: vec![AccountMeta::new(*authority.key, true), AccountMeta::new(*res.key, true)],
        data: cd,
    };
    invoke_signed(&create, &[authority.clone(), res.clone(), accounts[6].clone()], &[&[b"res", &mid, &[res_bump]]])?;

    let mut d = res.try_borrow_mut_data()?;
    d[0..4].copy_from_slice(&RES_MAGIC.to_le_bytes());
    d[R_BUMP] = res_bump;
    d[R_LEG0_KEY..R_LEG0_KEY + 4].copy_from_slice(&leg0_key.to_le_bytes());
    d[R_LEG0_PERIOD..R_LEG0_PERIOD + 4].copy_from_slice(&leg0_period.to_le_bytes());
    d[R_LEG1_KEY..R_LEG1_KEY + 4].copy_from_slice(&leg1_key.to_le_bytes());
    d[R_LEG1_PERIOD..R_LEG1_PERIOD + 4].copy_from_slice(&leg1_period.to_le_bytes());
    d[R_OP] = op;
    d[R_CMP] = cmp;
    d[R_THRESHOLD..R_THRESHOLD + 4].copy_from_slice(&threshold.to_le_bytes());
    d[R_NLEGS] = n_legs;
    d[R_NO_MINT..R_NO_MINT + 32].copy_from_slice(no_mint.key.as_ref());
    d[R_PAYOUT..R_PAYOUT + 8].copy_from_slice(&payout.to_le_bytes());
    d[R_ORACLE..R_ORACLE + 32].copy_from_slice(&oracle_program);
    // resolved/winning/values left zero until RESOLVE
    Ok(())
}

/// MintSet: deposit `amount * payout` quote collateral, receive `amount` YES + `amount` NO. This is
/// what funds redemptions — every outstanding winning share is backed 1:payout in the quote vault.
/// data: [8][market_id u64][book_bump u8][amount u64]
/// accounts: [user(s), book_pda, market_cfg, res, user_quote(w), quote_vault(w), base_mint(w),
///            no_mint(w), user_yes(w), user_no(w), token_program]
fn mint_set(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    if data.len() < 18 { return Err(ProgramError::InvalidInstructionData); }
    if accounts.len() < 11 { return Err(ProgramError::NotEnoughAccountKeys); }
    let market_id = rd_u64(data, 1);
    let bump = data[9];
    let amount = rd_u64(data, 10);
    if amount == 0 { return Err(ProgramError::InvalidArgument); }
    let (user, book, cfg_ai, res) = (&accounts[0], &accounts[1], &accounts[2], &accounts[3]);
    let (user_quote, quote_vault, base_mint, no_mint) = (&accounts[4], &accounts[5], &accounts[6], &accounts[7]);
    let (user_yes, user_no, token) = (&accounts[8], &accounts[9], &accounts[10]);
    if !user.is_signer { return Err(ProgramError::MissingRequiredSignature); }

    let cfg = read_cfg(cfg_ai, program_id, market_id)?;
    check_res(res, program_id, market_id)?;
    let derived = Pubkey::create_program_address(&[b"book", &market_id.to_le_bytes(), &[bump]], program_id)
        .map_err(|_| ProgramError::InvalidArgument)?;
    if derived != *book.key { return Err(ProgramError::InvalidArgument); }
    // bind the canonical mints + vault
    if base_mint.key.to_bytes() != cfg.base_mint || quote_vault.key.to_bytes() != cfg.quote_vault {
        return Err(ProgramError::InvalidArgument);
    }
    let (payout, no_mint_want) = { let d = res.try_borrow_data()?;
        (rd_u64(&d, R_PAYOUT), <[u8; 32]>::try_from(&d[R_NO_MINT..R_NO_MINT + 32]).unwrap()) };
    if no_mint.key.to_bytes() != no_mint_want { return Err(ProgramError::InvalidArgument); }
    // user token accounts must be the user's, of the right mints
    if ta_field(user_quote, TA_MINT)? != cfg.quote_mint { return Err(ProgramError::InvalidArgument); }
    if ta_field(user_yes, TA_MINT)? != cfg.base_mint || ta_field(user_yes, TA_OWNER)? != user.key.to_bytes() { return Err(ProgramError::InvalidArgument); }
    if ta_field(user_no, TA_MINT)? != no_mint_want || ta_field(user_no, TA_OWNER)? != user.key.to_bytes() { return Err(ProgramError::InvalidArgument); }

    let collateral = amount.checked_mul(payout).ok_or(ProgramError::ArithmeticOverflow)?;
    let seeds: &[&[u8]] = &[b"book", &market_id.to_le_bytes(), &[bump]];
    // 1) pull collateral (user signs) 2) mint the complete set (book PDA signs)
    token_transfer(token, user_quote, quote_vault, user, collateral, None)?;
    token_op(TOKEN_MINTTO, token, base_mint, user_yes, book, amount, Some(&[seeds]))?;
    token_op(TOKEN_MINTTO, token, no_mint, user_no, book, amount, Some(&[seeds]))?;
    Ok(())
}

/// Resolve: CPI txoracle `validate_stat_v3` with the caller's proof payload + OUR stored predicate,
/// then stamp the winning side from the bool it returns. Trustless: the oracle checks the multiproof
/// against its own published root, and the predicate comes from the res PDA (fixed at creation), so a
/// settler can supply neither a false proof nor a self-serving predicate. The caller's payload leaves
/// are bound to the market's legs (key + period) so it can't substitute real proofs for other stats.
/// data: [5][market_id u64][payload: borsh StatValidationInputV3]
/// accounts: [caller(s), res(w), market_cfg, oracle_program, daily_scores_roots]
fn resolve(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    if data.len() < 9 { return Err(ProgramError::InvalidInstructionData); }
    if accounts.len() < 5 { return Err(ProgramError::NotEnoughAccountKeys); }
    let market_id = rd_u64(data, 1);
    let payload_bytes = &data[9..];
    let (caller, res, cfg_ai, oracle, roots) = (&accounts[0], &accounts[1], &accounts[2], &accounts[3], &accounts[4]);
    if !caller.is_signer { return Err(ProgramError::MissingRequiredSignature); }

    read_cfg(cfg_ai, program_id, market_id)?; // market must exist (binds market_id space)
    check_res(res, program_id, market_id)?;
    let (leg0_key, leg0_period, leg1_key, leg1_period, op, cmp, threshold, n_legs, oracle_want, already) = {
        let d = res.try_borrow_data()?;
        (u32::from_le_bytes(d[R_LEG0_KEY..R_LEG0_KEY + 4].try_into().unwrap()),
         i32::from_le_bytes(d[R_LEG0_PERIOD..R_LEG0_PERIOD + 4].try_into().unwrap()),
         u32::from_le_bytes(d[R_LEG1_KEY..R_LEG1_KEY + 4].try_into().unwrap()),
         i32::from_le_bytes(d[R_LEG1_PERIOD..R_LEG1_PERIOD + 4].try_into().unwrap()),
         d[R_OP], d[R_CMP], i32::from_le_bytes(d[R_THRESHOLD..R_THRESHOLD + 4].try_into().unwrap()),
         d[R_NLEGS], <[u8; 32]>::try_from(&d[R_ORACLE..R_ORACLE + 32]).unwrap(), d[R_RESOLVED])
    };
    if already != 0 { return Err(ProgramError::InvalidArgument); } // settle once
    if oracle.key.to_bytes() != oracle_want { return Err(ProgramError::IncorrectProgramId); } // the bound oracle

    // parse the payload to bind its leaves to OUR predicate's legs (values stay the caller's).
    let payload = StatValidationInputV3::try_from_slice(payload_bytes)
        .map_err(|_| ProgramError::InvalidInstructionData)?;
    if payload.leaves.len() != n_legs as usize { return Err(ProgramError::InvalidArgument); }
    let v0 = payload.leaves[0].stat.value;
    if payload.leaves[0].stat.key != leg0_key || payload.leaves[0].stat.period != leg0_period {
        return Err(ProgramError::InvalidArgument);
    }
    let mut v1 = 0i32;
    if n_legs == 2 {
        let l1 = &payload.leaves[1].stat;
        if l1.key != leg1_key || l1.period != leg1_period { return Err(ProgramError::InvalidArgument); }
        v1 = l1.value;
    }

    // the roots account must be the txoracle's daily_scores_roots PDA for the PROOF's own day.
    let epoch_day = payload.ts.div_euclid(MS_PER_DAY) as u16;
    let (roots_pda, _) = Pubkey::find_program_address(&[SCORES_ROOTS_SEED, &epoch_day.to_le_bytes()], oracle.key);
    if roots_pda != *roots.key { return Err(ProgramError::InvalidArgument); }
    if roots.owner != oracle.key { return Err(ProgramError::IllegalOwner); }

    // THE trustless step: oracle verifies the multiproof against its root + evaluates our predicate.
    let strategy = build_strategy(n_legs, op, cmp, threshold)?;
    let win = cpi_validate_stat_v3(oracle, roots, payload_bytes, &strategy)?;

    let mut d = res.try_borrow_mut_data()?;
    d[R_RESOLVED] = 1;
    d[R_WINNING] = if win { 1 } else { 0 };
    d[R_VAL0..R_VAL0 + 4].copy_from_slice(&v0.to_le_bytes());
    d[R_VAL1..R_VAL1 + 4].copy_from_slice(&v1.to_le_bytes());
    Ok(())
}

/// Redeem: after RESOLVE, burn `amount` of the winning-side mint and pay `amount * payout` quote
/// from the vault. Losing-side shares are worth 0 (no redemption path).
/// data: [6][market_id u64][book_bump u8][amount u64]
/// accounts: [holder(s), book_pda, market_cfg, res, winning_mint(w), holder_win(w),
///            quote_vault(w), holder_quote(w), token_program]
fn redeem(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    if data.len() < 18 { return Err(ProgramError::InvalidInstructionData); }
    if accounts.len() < 9 { return Err(ProgramError::NotEnoughAccountKeys); }
    let market_id = rd_u64(data, 1);
    let bump = data[9];
    let amount = rd_u64(data, 10);
    if amount == 0 { return Err(ProgramError::InvalidArgument); }
    let (holder, book, cfg_ai, res) = (&accounts[0], &accounts[1], &accounts[2], &accounts[3]);
    let (win_mint, holder_win, quote_vault, holder_quote, token) =
        (&accounts[4], &accounts[5], &accounts[6], &accounts[7], &accounts[8]);
    if !holder.is_signer { return Err(ProgramError::MissingRequiredSignature); }

    let cfg = read_cfg(cfg_ai, program_id, market_id)?;
    check_res(res, program_id, market_id)?;
    let derived = Pubkey::create_program_address(&[b"book", &market_id.to_le_bytes(), &[bump]], program_id)
        .map_err(|_| ProgramError::InvalidArgument)?;
    if derived != *book.key { return Err(ProgramError::InvalidArgument); }
    if quote_vault.key.to_bytes() != cfg.quote_vault { return Err(ProgramError::InvalidArgument); }

    let (resolved, winning, payout, no_mint) = { let d = res.try_borrow_data()?;
        (d[R_RESOLVED], d[R_WINNING], rd_u64(&d, R_PAYOUT), <[u8; 32]>::try_from(&d[R_NO_MINT..R_NO_MINT + 32]).unwrap()) };
    if resolved == 0 { return Err(ProgramError::InvalidArgument); } // not settled yet

    // the winning mint is YES(base) if YES won, else NO
    let want_mint = if winning == 1 { cfg.base_mint } else { no_mint };
    if win_mint.key.to_bytes() != want_mint { return Err(ProgramError::InvalidArgument); }
    // holder's share account + payout account must be the holder's, of the right mints
    if ta_field(holder_win, TA_MINT)? != want_mint || ta_field(holder_win, TA_OWNER)? != holder.key.to_bytes() {
        return Err(ProgramError::IllegalOwner);
    }
    if ta_field(holder_quote, TA_MINT)? != cfg.quote_mint || ta_field(holder_quote, TA_OWNER)? != holder.key.to_bytes() {
        return Err(ProgramError::IllegalOwner);
    }

    let payoff = amount.checked_mul(payout).ok_or(ProgramError::ArithmeticOverflow)?;
    let seeds: &[&[u8]] = &[b"book", &market_id.to_le_bytes(), &[bump]];
    // 1) burn the winning shares (holder signs) 2) pay quote from the vault (book PDA signs)
    token_op(TOKEN_BURN, token, holder_win, win_mint, holder, amount, None)?;
    token_transfer(token, quote_vault, holder_quote, book, payoff, Some(&[seeds]))?;
    Ok(())
}

// ============================================================================================
// TornaFan — Hi-Lo pick'em with a live, on-chain leaderboard
// --------------------------------------------------------------------------------------------
// A game calls Hi-Lo on one TxLINE stat (e.g. corners). Players PLACE_PICK Higher/Lower for the open
// round. RESOLVE_ROUND verifies the round's stat with a TxLINE proof (trustless) and stamps the
// Higher/Lower outcome. SCORE_ONE then scores one player and mirrors their score to the leaderboard
// Torna tree — keyed by player, so N players' updates touch N different leaves and commit in
// PARALLEL in one slot. The ranking itself is a cheap off-chain re-sort of the tree.
// ============================================================================================

/// Create a program-owned PDA account via the system program, signed by `seeds`.
fn create_pda<'a>(
    payer: &AccountInfo<'a>, acct: &AccountInfo<'a>, system: &AccountInfo<'a>,
    program_id: &Pubkey, rent: u64, size: usize, seeds: &[&[u8]],
) -> ProgramResult {
    let mut cd = vec![0u8; 4];
    cd.extend_from_slice(&rent.to_le_bytes());
    cd.extend_from_slice(&(size as u64).to_le_bytes());
    cd.extend_from_slice(program_id.as_ref());
    let create = Instruction {
        program_id: Pubkey::default(),
        accounts: vec![AccountMeta::new(*payer.key, true), AccountMeta::new(*acct.key, true)],
        data: cd,
    };
    invoke_signed(&create, &[payer.clone(), acct.clone(), system.clone()], &[seeds])
}

/// Validate a program-owned PDA: owner, magic, and the canonical seeds (from the stored bump at `G_BUMP`/`P_BUMP`).
fn check_pda(acct: &AccountInfo, program_id: &Pubkey, magic: u32, size: usize, bump_off: usize, seeds_no_bump: &[&[u8]]) -> ProgramResult {
    if acct.owner != program_id { return Err(ProgramError::IncorrectProgramId); }
    let d = acct.try_borrow_data()?;
    if d.len() < size || u32::from_le_bytes(d[0..4].try_into().unwrap()) != magic { return Err(ProgramError::InvalidAccountData); }
    let bump = d[bump_off];
    let mut seeds: Vec<&[u8]> = seeds_no_bump.to_vec();
    let b = [bump];
    seeds.push(&b);
    let derived = Pubkey::create_program_address(&seeds, program_id).map_err(|_| ProgramError::InvalidArgument)?;
    if derived != *acct.key { return Err(ProgramError::InvalidArgument); }
    Ok(())
}

/// Leaderboard value (40B, matches the tree's value_size): score(8 BE) | streak(8 BE) | pad.
fn lb_value(score: u32, streak: u16) -> [u8; 40] {
    let mut v = [0u8; 40];
    v[0..8].copy_from_slice(&(score as u64).to_be_bytes());
    v[8..16].copy_from_slice(&(streak as u64).to_be_bytes());
    v
}

/// InitGame: create the game config + bind its leaderboard tree (authority = [b"lb", game_id]).
/// data: [9][game_id u64][fixture_id u64][stat_key u32][stat_period i32][round_id u32][prev_value i32]
///        [oracle 32][rent u64]
/// accounts: [authority(s,w), game_cfg(w), lb_pda, torna, lb_header, system]
fn init_game(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    if data.len() < 73 { return Err(ProgramError::InvalidInstructionData); }
    if accounts.len() < 6 { return Err(ProgramError::NotEnoughAccountKeys); }
    let game_id = rd_u64(data, 1);
    let fixture_id = rd_u64(data, 9);
    let stat_key = u32::from_le_bytes(data[17..21].try_into().unwrap());
    let stat_period = i32::from_le_bytes(data[21..25].try_into().unwrap());
    let round_id = u32::from_le_bytes(data[25..29].try_into().unwrap());
    let prev_value = i32::from_le_bytes(data[29..33].try_into().unwrap());
    let oracle: [u8; 32] = data[33..65].try_into().unwrap();
    let rent = rd_u64(data, 65);
    let (authority, game, lb, torna, lb_header, system) =
        (&accounts[0], &accounts[1], &accounts[2], &accounts[3], &accounts[4], &accounts[5]);
    if !authority.is_signer { return Err(ProgramError::MissingRequiredSignature); }

    let gid = game_id.to_le_bytes();
    let (game_pda, game_bump) = Pubkey::find_program_address(&[b"game", &gid], program_id);
    let (lb_pda, lb_bump) = Pubkey::find_program_address(&[b"lb", &gid], program_id);
    if game_pda != *game.key || lb_pda != *lb.key { return Err(ProgramError::InvalidArgument); }

    // the leaderboard header must be a genuine Torna tree whose sole writer is the lb PDA, value_size 40
    if lb_header.owner != torna.key { return Err(ProgramError::IncorrectProgramId); }
    {
        let hd = lb_header.try_borrow_data()?;
        if hd.len() < H_AUTHORITY + 32 { return Err(ProgramError::InvalidArgument); }
        if hd[H_AUTHORITY..H_AUTHORITY + 32] != lb.key.to_bytes() { return Err(ProgramError::InvalidArgument); }
        if u16::from_le_bytes(hd[H_VALUE_SIZE..H_VALUE_SIZE + 2].try_into().unwrap()) != 40 { return Err(ProgramError::InvalidArgument); }
    }

    create_pda(authority, game, system, program_id, rent, GAME_SIZE, &[b"game", &gid, &[game_bump]])?;
    let mut d = game.try_borrow_mut_data()?;
    d[0..4].copy_from_slice(&GAME_MAGIC.to_le_bytes());
    d[G_BUMP] = game_bump;
    d[G_FIXTURE..G_FIXTURE + 8].copy_from_slice(&fixture_id.to_le_bytes());
    d[G_STAT_KEY..G_STAT_KEY + 4].copy_from_slice(&stat_key.to_le_bytes());
    d[G_STAT_PERIOD..G_STAT_PERIOD + 4].copy_from_slice(&stat_period.to_le_bytes());
    d[G_ORACLE..G_ORACLE + 32].copy_from_slice(&oracle);
    d[G_TORNA..G_TORNA + 32].copy_from_slice(torna.key.as_ref());
    d[G_LB_HEADER..G_LB_HEADER + 32].copy_from_slice(lb_header.key.as_ref());
    d[G_ROUND_ID..G_ROUND_ID + 4].copy_from_slice(&round_id.to_le_bytes());
    d[G_PREV_VALUE..G_PREV_VALUE + 4].copy_from_slice(&prev_value.to_le_bytes());
    d[G_LAST_ROUND..G_LAST_ROUND + 4].copy_from_slice(&0u32.to_le_bytes());
    d[G_OUTCOME] = 2; // none yet
    d[G_LB_BUMP] = lb_bump;
    Ok(())
}

/// PlacePick: record a Higher/Lower call for the current open round.
/// data: [10][game_id u64][round_id u32][dir u8][pk_bump u8][rent u64]
/// accounts: [player(s,w), game_cfg, pick(w), system]
fn place_pick(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    if data.len() < 23 { return Err(ProgramError::InvalidInstructionData); }
    if accounts.len() < 4 { return Err(ProgramError::NotEnoughAccountKeys); }
    let game_id = rd_u64(data, 1);
    let round_id = u32::from_le_bytes(data[9..13].try_into().unwrap());
    let dir = data[13];
    let pk_bump = data[14];
    let rent = rd_u64(data, 15);
    let (player, game, pick, system) = (&accounts[0], &accounts[1], &accounts[2], &accounts[3]);
    if !player.is_signer { return Err(ProgramError::MissingRequiredSignature); }
    if dir > 1 { return Err(ProgramError::InvalidArgument); }

    let gid = game_id.to_le_bytes();
    check_pda(game, program_id, GAME_MAGIC, GAME_SIZE, G_BUMP, &[b"game", &gid])?;
    { // pick must be for the CURRENT open round
        let g = game.try_borrow_data()?;
        if u32::from_le_bytes(g[G_ROUND_ID..G_ROUND_ID + 4].try_into().unwrap()) != round_id {
            return Err(ProgramError::InvalidArgument);
        }
    }
    let rid = round_id.to_le_bytes();
    let seeds: &[&[u8]] = &[b"pk", &gid, &rid, player.key.as_ref(), &[pk_bump]];
    let derived = Pubkey::create_program_address(seeds, program_id).map_err(|_| ProgramError::InvalidArgument)?;
    if derived != *pick.key { return Err(ProgramError::InvalidArgument); }

    create_pda(player, pick, system, program_id, rent, PICK_SIZE, seeds)?;
    let mut d = pick.try_borrow_mut_data()?;
    d[0..4].copy_from_slice(&PICK_MAGIC.to_le_bytes());
    d[PK_BUMP] = pk_bump;
    d[PK_DIR] = dir;
    Ok(())
}

/// ResolveRound: verify the round's stat via a TxLINE proof, stamp Higher/Lower, advance the round.
/// The proof makes it trustless — the outcome comes from TxLINE's on-chain root, not the caller.
/// data: [11][game_id u64][payload: borsh StatValidationInputV3]
/// accounts: [caller(s), game_cfg(w), oracle, daily_scores_roots]
fn resolve_round(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    if data.len() < 9 { return Err(ProgramError::InvalidInstructionData); }
    if accounts.len() < 4 { return Err(ProgramError::NotEnoughAccountKeys); }
    let game_id = rd_u64(data, 1);
    let payload_bytes = &data[9..];
    let (caller, game, oracle, roots) = (&accounts[0], &accounts[1], &accounts[2], &accounts[3]);
    if !caller.is_signer { return Err(ProgramError::MissingRequiredSignature); }

    let gid = game_id.to_le_bytes();
    check_pda(game, program_id, GAME_MAGIC, GAME_SIZE, G_BUMP, &[b"game", &gid])?;
    let (stat_key, stat_period, oracle_want, round_id, prev_value) = {
        let g = game.try_borrow_data()?;
        (u32::from_le_bytes(g[G_STAT_KEY..G_STAT_KEY + 4].try_into().unwrap()),
         i32::from_le_bytes(g[G_STAT_PERIOD..G_STAT_PERIOD + 4].try_into().unwrap()),
         <[u8; 32]>::try_from(&g[G_ORACLE..G_ORACLE + 32]).unwrap(),
         u32::from_le_bytes(g[G_ROUND_ID..G_ROUND_ID + 4].try_into().unwrap()),
         i32::from_le_bytes(g[G_PREV_VALUE..G_PREV_VALUE + 4].try_into().unwrap()))
    };
    if oracle.key.to_bytes() != oracle_want { return Err(ProgramError::IncorrectProgramId); }

    // parse the proof payload; the single proven leaf must be OUR stat.
    let payload = StatValidationInputV3::try_from_slice(payload_bytes).map_err(|_| ProgramError::InvalidInstructionData)?;
    if payload.leaves.len() != 1 { return Err(ProgramError::InvalidArgument); }
    let leaf = &payload.leaves[0].stat;
    // Bind only the stat KEY: a live Hi-Lo game resolves at whatever the current in-play status
    // (period) is, so the period varies across rounds and must not be pinned. The proof still binds
    // the value to TxLINE's root, so the value is genuine. (stat_period is retained as metadata.)
    let _ = stat_period;
    if leaf.key != stat_key { return Err(ProgramError::InvalidArgument); }
    let proven = leaf.value;

    // roots PDA for the proof's own day, under the bound oracle
    let epoch_day = payload.ts.div_euclid(MS_PER_DAY) as u16;
    let (roots_pda, _) = Pubkey::find_program_address(&[SCORES_ROOTS_SEED, &epoch_day.to_le_bytes()], oracle.key);
    if roots_pda != *roots.key || roots.owner != oracle.key { return Err(ProgramError::InvalidArgument); }

    // an always-true predicate: we only need the oracle to VERIFY the proof (Ok), then trust the value.
    let strategy = build_strategy(1, 0, 0, i32::MIN)?; // Single(index0): value > i32::MIN
    cpi_validate_stat_v3(oracle, roots, payload_bytes, &strategy)?;

    // binary Hi-Lo: provable stats (corners/cards/goals) only ever rise, so the call is "will it go
    // up before the next update?" — Higher(1) if it increased, Lower(0) if it stayed the same.
    let outcome: u8 = if proven > prev_value { 1 } else { 0 };
    let mut d = game.try_borrow_mut_data()?;
    d[G_LAST_ROUND..G_LAST_ROUND + 4].copy_from_slice(&round_id.to_le_bytes());
    d[G_OUTCOME] = outcome;
    d[G_PREV_VALUE..G_PREV_VALUE + 4].copy_from_slice(&proven.to_le_bytes());
    d[G_ROUND_ID..G_ROUND_ID + 4].copy_from_slice(&(round_id + 1).to_le_bytes());
    Ok(())
}

/// ScoreOne: score one player's pick for the last resolved round, and mirror their score to the
/// leaderboard tree (keyed by player). Different players hit different leaves -> parallel across a
/// batch of SCORE_ONE txs in the same slot.
/// data: [12][game_id u64][round_id u32][player 32][lb_bump u8][path_len u8]
/// accounts: [caller(s), game_cfg, player_pda(w), pick, lb_pda, torna, lb_header, path(leaf w)...]
fn score_one(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    if data.len() < 47 { return Err(ProgramError::InvalidInstructionData); }
    if accounts.len() < 7 { return Err(ProgramError::NotEnoughAccountKeys); }
    let game_id = rd_u64(data, 1);
    let round_id = u32::from_le_bytes(data[9..13].try_into().unwrap());
    let player: [u8; 32] = data[13..45].try_into().unwrap();
    let lb_bump = data[45];
    let path_len = data[46] as usize;
    if accounts.len() < 7 + path_len { return Err(ProgramError::NotEnoughAccountKeys); }
    let (caller, game, player_pda, pick, lb, torna, lb_header) =
        (&accounts[0], &accounts[1], &accounts[2], &accounts[3], &accounts[4], &accounts[5], &accounts[6]);
    let path = &accounts[7..7 + path_len];
    if !caller.is_signer { return Err(ProgramError::MissingRequiredSignature); }

    let gid = game_id.to_le_bytes();
    check_pda(game, program_id, GAME_MAGIC, GAME_SIZE, G_BUMP, &[b"game", &gid])?;
    let (last_round, outcome, torna_want, lb_header_want) = {
        let g = game.try_borrow_data()?;
        (u32::from_le_bytes(g[G_LAST_ROUND..G_LAST_ROUND + 4].try_into().unwrap()), g[G_OUTCOME],
         <[u8; 32]>::try_from(&g[G_TORNA..G_TORNA + 32]).unwrap(),
         <[u8; 32]>::try_from(&g[G_LB_HEADER..G_LB_HEADER + 32]).unwrap())
    };
    if round_id != last_round || outcome > 1 { return Err(ProgramError::InvalidArgument); } // resolved round, real outcome
    if torna.key.to_bytes() != torna_want || lb_header.key.to_bytes() != lb_header_want { return Err(ProgramError::InvalidArgument); }
    // bind the lb authority PDA
    let derived_lb = Pubkey::create_program_address(&[b"lb", &gid, &[lb_bump]], program_id).map_err(|_| ProgramError::InvalidArgument)?;
    if derived_lb != *lb.key { return Err(ProgramError::InvalidArgument); }

    // the player + pick accounts must be this player's canonical PDAs
    check_pda(player_pda, program_id, PLAYER_MAGIC, PLAYER_SIZE, P_BUMP, &[b"pl", &gid, &player])?;
    let rid = round_id.to_le_bytes();
    check_pda(pick, program_id, PICK_MAGIC, PICK_SIZE, PK_BUMP, &[b"pk", &gid, &rid, &player])?;

    let dir = { let p = pick.try_borrow_data()?; p[PK_DIR] };
    let (score, streak, in_lb) = {
        let p = player_pda.try_borrow_data()?;
        if u32::from_le_bytes(p[P_SCORED_ROUND..P_SCORED_ROUND + 4].try_into().unwrap()) == round_id && round_id != 0 {
            // already scored this round (round 0 is the pre-game default, so allow it once)
            return Err(ProgramError::InvalidArgument);
        }
        (u32::from_le_bytes(p[P_SCORE..P_SCORE + 4].try_into().unwrap()),
         u16::from_le_bytes(p[P_STREAK..P_STREAK + 2].try_into().unwrap()), p[P_IN_LB])
    };
    let correct = dir == outcome;
    let new_score = if correct { score + 1 } else { score };
    let new_streak = if correct { streak + 1 } else { 0 };

    // update the player's source of truth
    {
        let mut p = player_pda.try_borrow_mut_data()?;
        p[P_SCORE..P_SCORE + 4].copy_from_slice(&new_score.to_le_bytes());
        p[P_STREAK..P_STREAK + 2].copy_from_slice(&new_streak.to_le_bytes());
        p[P_SCORED_ROUND..P_SCORED_ROUND + 4].copy_from_slice(&round_id.to_le_bytes());
    }

    // mirror to the leaderboard tree (key = player), for the off-chain rank scan. Parallel by leaf.
    let key = player; // 32B
    let value = lb_value(new_score, new_streak);
    let seeds: &[&[u8]] = &[b"lb", &gid, &[lb_bump]];
    if in_lb == 0 {
        torna_cpi::insert_fast(torna, lb, lb_header, path, &key, &value, &[seeds])?;
        let mut p = player_pda.try_borrow_mut_data()?;
        p[P_IN_LB] = 1;
    } else {
        torna_cpi::update_fast(torna, lb, lb_header, path, &key, &value, &[seeds])?;
    }
    Ok(())
}

/// InitPlayer: create a player's score/streak state PDA [b"pl", game_id, player] once.
/// data: [13][game_id u64][player 32][pl_bump u8][rent u64]
/// accounts: [payer(s,w), player_pda(w), game_cfg, system]
fn init_player(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    if data.len() < 50 { return Err(ProgramError::InvalidInstructionData); }
    if accounts.len() < 4 { return Err(ProgramError::NotEnoughAccountKeys); }
    let game_id = rd_u64(data, 1);
    let player: [u8; 32] = data[9..41].try_into().unwrap();
    let pl_bump = data[41];
    let rent = rd_u64(data, 42);
    let (payer, player_pda, game, system) = (&accounts[0], &accounts[1], &accounts[2], &accounts[3]);
    if !payer.is_signer { return Err(ProgramError::MissingRequiredSignature); }

    let gid = game_id.to_le_bytes();
    check_pda(game, program_id, GAME_MAGIC, GAME_SIZE, G_BUMP, &[b"game", &gid])?;
    let seeds: &[&[u8]] = &[b"pl", &gid, &player, &[pl_bump]];
    let derived = Pubkey::create_program_address(seeds, program_id).map_err(|_| ProgramError::InvalidArgument)?;
    if derived != *player_pda.key { return Err(ProgramError::InvalidArgument); }

    create_pda(payer, player_pda, system, program_id, rent, PLAYER_SIZE, seeds)?;
    let mut d = player_pda.try_borrow_mut_data()?;
    d[0..4].copy_from_slice(&PLAYER_MAGIC.to_le_bytes());
    d[P_BUMP] = pl_bump;
    // score/streak/in_lb/scored_round are already zero
    Ok(())
}
