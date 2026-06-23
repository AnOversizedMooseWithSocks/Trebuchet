/*
 * vanity_keygen.c -- High-performance Solana vanity keypair generator.
 *
 * Multi-threaded Ed25519 keypair grind with provable epoch tracking.
 * Uses a deterministic seed chain:
 *   keypair_0 -> keypair_1 -> ... -> keypair_n (winner).
 * WARNING: The master seed IS the private key of the first keypair in the
 * chain. It must never be shared; it is NOT part of the public output.
 *   Common:    n <= 1 epoch
 *   Rare:      n <= 2 epochs
 *   Legendary: n <= 3 epochs
 *   Mythic:    n >  3 epochs
 *
 * Build:   make -C c
 * Usage:   ./c/build/vanity_keygen --prefix RAT --suffix i --threads 16
 */

#include <pthread.h>
#include <stdatomic.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>
#include <time.h>
#include <unistd.h>
#include <sys/time.h>

/* Cross-platform entropy source.
 *
 * On POSIX (macOS, Linux) we use getentropy() from <sys/random.h>.
 * Windows MinGW doesn't ship <sys/random.h> or getentropy(), so we
 * provide a same-shape static shim backed by BCryptGenRandom — the
 * Windows Crypto Next Generation RNG. This is the same source
 * randombytes.c uses for Windows, so the entropy story stays
 * consistent across the binary. The #pragma comment(lib, ...) is the
 * MinGW/MSVC idiom for telling the linker to pull in bcrypt.lib;
 * mirrors what randombytes.c already does. */
#if defined(_WIN32)
  #include <windows.h>
  #include <bcrypt.h>
  #include <io.h>      /* _setmode, _fileno */
  #include <fcntl.h>   /* _O_BINARY */
  #pragma comment(lib, "bcrypt.lib")

  static int getentropy(void *buf, size_t n) {
      while (n > 0) {
          ULONG chunk = (n > 0x7fffffffULL) ? 0x7fffffff : (ULONG)n;
          NTSTATUS s = BCryptGenRandom(NULL, (PUCHAR)buf, chunk,
                                       BCRYPT_USE_SYSTEM_PREFERRED_RNG);
          if (s != 0) return -1;
          buf = (char *)buf + chunk;
          n -= chunk;
      }
      return 0;
  }
#else
  #include <sys/random.h>
#endif

#include "tweetnacl.h"
#include "base58.h"
#include "vrf_ed25519.h"

/* ------------------------------------------------------------------ */
/* Deterministic seed chain for provable grind history                 */
/* ------------------------------------------------------------------ */

/* Each thread gets a unique seed derived from a master seed + thread id.
 * The seed chain advances by using the generated public key as the next
 * seed: seed_{i+1} = pk_i[0..31]. This is a deterministic one-way chain
 * (reversing it requires breaking Ed25519 preimage resistance).
 * The master seed is NEVER included in public output because it equals
 * the secret key of the first keypair in the chain. */

#define SEED_CHAIN_BYTES 32

/* ------------------------------------------------------------------ */
/* Fast suffix pre-check helpers                                       */
/* ------------------------------------------------------------------ */

/* For suffix targets up to 10 chars (58^10 < 2^64), we pre-check
 * pk % 58^target_len against the target's numeric value.  This skips
 * the full base58_encode on ~98% of iterations for typical 4-char
 * targets -- the single largest optimization in the hot loop.
 *
 * For case-insensitive matching, base58 characters have different
 * indices for different cases (e.g. 'R'=24, 'r'=49), so we enumerate
 * all 2^k case-variant numeric values and check against each. */
#define MAX_FAST_TARGET_LEN 10
#define MAX_CASE_VARIANTS    64

static uint64_t pow58(int exp) {
    uint64_t r = 1;
    for (int i = 0; i < exp; i++) r *= 58ULL;
    return r;
}

static uint64_t b58_to_u64(const char *s, int len, int *ok) {
    uint64_t v = 0;
    for (int i = 0; i < len; i++) {
        int digit = -1;
        for (int j = 0; BASE58_ALPHABET[j]; j++) {
            if (BASE58_ALPHABET[j] == s[i]) { digit = j; break; }
        }
        if (digit < 0) { *ok = 0; return 0; }
        v = v * 58ULL + (uint64_t)digit;
    }
    *ok = 1;
    return v;
}

static uint64_t pk_mod64(const uint8_t pk[32], uint64_t mod) {
    uint64_t r = 0;
    for (int i = 0; i < 32; i++)
        r = ((r << 8) | (uint64_t)pk[i]) % mod;
    return r;
}

/* Generate all case-variant numeric forms of an L-char base58 target.
 * For each position that is a letter (a-z, A-Z), both cases produce
 * different base58 digit values.  Enumerates all 2^k combinations
 * (capped at MAX_CASE_VARIANTS).  Returns the number of variants,
 * or 0 if too many (caller falls back to full encode). */
static int gen_case_variants(const char *target, int len,
                              uint64_t *variants, int max_variants) {
    int letter_positions[10];
    int n_letters = 0;
    for (int i = 0; i < len && n_letters < 10; i++) {
        char c = target[i];
        if ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z'))
            letter_positions[n_letters++] = i;
    }
    int total = 1 << n_letters;
    if (total > max_variants) return 0;

    /* Map each char to its two possible base58 indices */
    int b58_idx[2][10];
    for (int i = 0; i < len; i++) {
        char lo = (target[i] >= 'A' && target[i] <= 'Z')
                   ? (char)(target[i] | 0x20) : target[i];
        char up = (target[i] >= 'a' && target[i] <= 'z')
                   ? (char)(target[i] & ~0x20) : target[i];
        int idx_lo = -1, idx_up = -1;
        for (int j = 0; BASE58_ALPHABET[j]; j++) {
            if (BASE58_ALPHABET[j] == lo) idx_lo = j;
            if (BASE58_ALPHABET[j] == up) idx_up = j;
        }
        if (idx_lo < 0 || idx_up < 0) return 0;
        b58_idx[0][i] = idx_lo;
        b58_idx[1][i] = idx_up;
    }

    for (int mask = 0; mask < total; mask++) {
        uint64_t v = 0;
        for (int pos = 0; pos < len; pos++) {
            int use_up = 0;
            for (int k = 0; k < n_letters; k++) {
                if (letter_positions[k] == pos) {
                    use_up = (mask >> k) & 1;
                    break;
                }
            }
            v = v * 58ULL + (uint64_t)b58_idx[use_up][pos];
        }
        variants[mask] = v;
    }
    return total;
}

/* ------------------------------------------------------------------ */
/* Shared state across threads */
/* ------------------------------------------------------------------ */

typedef struct {
    atomic_bool  found;
    uint8_t      result_pk[32];
    uint8_t      result_sk[64];
    char         result_b58[48];
    uint64_t     result_attempt;
    char         last_pk[48];
    atomic_int   last_pk_ready;
    const char  *prefix;
    int          prefix_len;
    const char  *suffix;
    int          suffix_len;
    int          case_sensitive;
    atomic_ullong total_attempts;
    atomic_int   running_threads;
    uint8_t      master_seed[32];
    uint64_t     attempts_per_thread;
    /* Fast suffix match: modular check with case-variant support */
    int          use_fast_match;
    uint64_t     fast_mod;
    int          fast_num_variants;
    uint64_t     fast_target_vals[MAX_CASE_VARIANTS];
} grind_state_t;

typedef struct {
    int            id;
    grind_state_t *state;
} thread_arg_t;

#define FLUSH_INTERVAL 16384

/* ------------------------------------------------------------------ */
/* Worker thread */
/* ------------------------------------------------------------------ */

static int check_part(const char *b58, size_t b58_len,
                      const char *target, int target_len,
                      int at_start, int case_sensitive) {
    if (!target || target_len <= 0) return 1;
    if (b58_len < (size_t)target_len) return 0;
    if (at_start) {
        if (case_sensitive)
            return memcmp(b58, target, (size_t)target_len) == 0;
        else
            return strncasecmp(b58, target, (size_t)target_len) == 0;
    } else {
        const char *tail = b58 + b58_len - target_len;
        if (case_sensitive)
            return memcmp(tail, target, (size_t)target_len) == 0;
        else
            return strncasecmp(tail, target, (size_t)target_len) == 0;
    }
}

static int check_match(const char *b58, size_t b58_len,
                       const char *prefix, int prefix_len,
                       const char *suffix, int suffix_len,
                       int case_sensitive) {
    return check_part(b58, b58_len, prefix, prefix_len, 1, case_sensitive)
        && check_part(b58, b58_len, suffix, suffix_len, 0, case_sensitive);
}

/* CAS-guarded progress sample: encode pk for the display line */
static inline void progress_sample(grind_state_t *gs, const uint8_t pk[32]) {
    int expected_flag = 0;
    if (atomic_compare_exchange_strong(&gs->last_pk_ready,
                                       &expected_flag, 1)) {
        base58_encode(pk, 32, gs->last_pk, sizeof(gs->last_pk));
        atomic_store_explicit(&gs->last_pk_ready, 1, memory_order_release);
    }
}

static void *grind_thread(void *arg) {
    thread_arg_t *ta = (thread_arg_t *)arg;
    grind_state_t *gs = ta->state;
    uint64_t local_attempts = 0;
    uint64_t global_base = (uint64_t)ta->id * gs->attempts_per_thread;

    /* Derive thread-specific seed from master_seed. */
    uint8_t thread_seed[32];
    memcpy(thread_seed, gs->master_seed, 32);
    uint64_t tid = (uint64_t)ta->id;
    for (int i = 0; i < 8; i++) thread_seed[i] ^= (uint8_t)(tid >> (i * 8));
    {
        uint8_t tmp_pk[32], tmp_sk[64];
        crypto_sign_keypair_from_seed(tmp_pk, tmp_sk, thread_seed);
        memcpy(thread_seed, tmp_pk, 32);
    }

    uint8_t pk[32], sk[64];
    uint8_t seed[32];
    char    b58[48];

    memcpy(seed, thread_seed, 32);

    int use_fast = gs->use_fast_match;

    while (!atomic_load_explicit(&gs->found, memory_order_relaxed)) {
        crypto_sign_keypair_from_seed(pk, sk, seed);

        int matched = 0;

        if (use_fast) {
            /* Suffix fast-path: pk % 58^L in variant set.
             * Only do the full base58 encode + string match on a hit,
             * which happens ~1 in 58^target_len iterations. */
            uint64_t rem = pk_mod64(pk, gs->fast_mod);
            int hit = 0;
            for (int v = 0; v < gs->fast_num_variants; v++) {
                if (rem == gs->fast_target_vals[v]) { hit = 1; break; }
            }
            if (hit) {
                size_t b58_len = base58_encode(pk, 32, b58, sizeof(b58));
                if (b58_len > 0) {
                    matched = check_match(b58, b58_len,
                                          gs->prefix, gs->prefix_len,
                                          gs->suffix, gs->suffix_len,
                                          gs->case_sensitive);
                }
            }
            if ((local_attempts & 0xFFF) == 0)
                progress_sample(gs, pk);

        } else {
            /* Full encode every iteration (prefix mode or long suffix) */
            size_t b58_len = base58_encode(pk, 32, b58, sizeof(b58));
            if (b58_len > 0) {
                if ((local_attempts & 0xFFF) == 0) {
                    int expected_flag = 0;
                    if (atomic_compare_exchange_strong(&gs->last_pk_ready,
                                                       &expected_flag, 1)) {
                        memcpy(gs->last_pk, b58, b58_len + 1);
                        atomic_store_explicit(&gs->last_pk_ready, 1,
                                              memory_order_release);
                    }
                }
                matched = check_match(b58, b58_len,
                                      gs->prefix, gs->prefix_len,
                                      gs->suffix, gs->suffix_len,
                                      gs->case_sensitive);
            }
        }

        local_attempts++;

        if (matched) {
            bool expected = false;
            if (atomic_compare_exchange_strong(&gs->found, &expected, true)) {
                memcpy(gs->result_pk, pk, 32);
                memcpy(gs->result_sk, sk, 64);
                memcpy(gs->result_b58, b58, sizeof(b58));
                gs->result_attempt = global_base + local_attempts;
            }
            break;
        }

        memcpy(seed, pk, 32);

        if (local_attempts >= FLUSH_INTERVAL) {
            atomic_fetch_add(&gs->total_attempts, local_attempts);
            local_attempts = 0;
        }
    }

    if (local_attempts > 0)
        atomic_fetch_add(&gs->total_attempts, local_attempts);
    atomic_fetch_sub(&gs->running_threads, 1);
    return NULL;
}

/* ------------------------------------------------------------------ */
/* Rarity tier */
/* ------------------------------------------------------------------ */

typedef enum { RARITY_COMMON, RARITY_RARE, RARITY_LEGENDARY, RARITY_MYTHIC } rarity_tier_t;

static const char *rarity_name(rarity_tier_t r) {
    switch (r) {
        case RARITY_COMMON:    return "Common";
        case RARITY_RARE:      return "Rare";
        case RARITY_LEGENDARY: return "Legendary";
        default:               return "Mythic";
    }
}

static rarity_tier_t classify_rarity(uint64_t attempts, double expected) {
    if (attempts <= (uint64_t)expected)       return RARITY_COMMON;
    if (attempts <= (uint64_t)(expected * 2)) return RARITY_RARE;
    if (attempts <= (uint64_t)(expected * 3)) return RARITY_LEGENDARY;
    return RARITY_MYTHIC;
}

/* ------------------------------------------------------------------ */
/* Main */
/* ------------------------------------------------------------------ */

static void print_usage(const char *prog) {
    fprintf(stderr,
        "Usage: %s [--prefix <PREFIX>] [--suffix <SUFFIX>]\n"
        "       [--threads <N>] [--out <FILE>]\n"
        "       [--case-insensitive] [--quiet]\n"
        "\n"
        "  --prefix PREFIX       Match start of address\n"
        "  --suffix SUFFIX       Match end of address\n"
        "                         Provide both to match start and end\n"
        "  --threads N           Worker threads (default: CPU count)\n"
        "  --out FILE            Output JSON keypair file (default: stdout)\n"
        "  --vrf-blockhash HEX    Solana blockhash for VRF seed binding\n"
        "  --case-insensitive    Case-insensitive matching\n"
        "  --quiet               Suppress progress output\n"
        "\n"
        "Output JSON includes provable grind proof:\n"
        "  { secretKey, publicKey, attempts, rarity, expectedAttempts, vrfProof, vrfPk, vrfBlockhash }\n"
        "\n"
        "Examples:\n"
        "  %s --suffix RATi --threads 16 --out rati-ca.json\n"
        "  %s --prefix RAT --suffix i --threads 16\n",
        prog, prog, prog);
}

static int validate_base58_target(const char *label, const char *target,
                                  int case_sensitive) {
    int len = target ? (int)strlen(target) : 0;
    if (len == 0) return 0;
    for (int i = 0; i < len; i++) {
        int valid = 0;
        for (int j = 0; BASE58_ALPHABET[j]; j++) {
            char tc = case_sensitive ? target[i] : (char)(target[i] | 0x20);
            char ac = case_sensitive ? BASE58_ALPHABET[j] : (char)(BASE58_ALPHABET[j] | 0x20);
            if (tc == ac) { valid = 1; break; }
        }
        if (!valid) {
            fprintf(stderr, "Error: %s contains '%c', which is not valid base58\n",
                    label, target[i]);
            return -1;
        }
    }
    return len;
}

static void make_target_label(const char *prefix, const char *suffix,
                              char out[96]) {
    if (prefix && suffix)
        snprintf(out, 96, "%s...%s", prefix, suffix);
    else if (prefix)
        snprintf(out, 96, "%s", prefix);
    else if (suffix)
        snprintf(out, 96, "%s", suffix);
    else
        out[0] = '\0';
}

static int get_cpu_count(void) {
#if defined(_WIN32)
    /* Windows: <windows.h> is already included in the platform block
     * at the top of the file. GetSystemInfo reports the number of
     * logical processors, the same semantic sysconf returns on POSIX. */
    SYSTEM_INFO si;
    GetSystemInfo(&si);
    return (si.dwNumberOfProcessors > 0) ? (int)si.dwNumberOfProcessors : 4;
#else
    long n = sysconf(_SC_NPROCESSORS_ONLN);
    return (n > 0) ? (int)n : 4;
#endif
}

static void b58_of(const uint8_t bytes[32], char out[48]) {
    base58_encode(bytes, 32, out, 48);
}

static int hex_decode(const char *hex, uint8_t *out, int out_len) {
    int len = (int)strlen(hex);
    if (len != out_len * 2) return -1;
    for (int i = 0; i < out_len; i++) {
        char hi = hex[i * 2], lo = hex[i * 2 + 1];
        int val = 0;
        if (hi >= '0' && hi <= '9') val = (hi - '0') << 4;
        else if (hi >= 'a' && hi <= 'f') val = (hi - 'a' + 10) << 4;
        else if (hi >= 'A' && hi <= 'F') val = (hi - 'A' + 10) << 4;
        else return -1;
        if (lo >= '0' && lo <= '9') val |= (lo - '0');
        else if (lo >= 'a' && lo <= 'f') val |= (lo - 'a' + 10);
        else if (lo >= 'A' && lo <= 'F') val |= (lo - 'A' + 10);
        else return -1;
        out[i] = (uint8_t)val;
    }
    return 0;
}

static void hex_encode(const uint8_t *in, int len, char *out) {
    for (int i = 0; i < len; i++)
        sprintf(out + i * 2, "%02x", in[i]);
    out[len * 2] = '\0';
}

int main(int argc, char **argv) {
#if defined(_WIN32)
    /* Switch stdout to binary mode so the C runtime doesn't translate
     * \n into \r\n. Today's JSON output is single-line, so the Node
     * side's stdout.trim() forgives the trailing translation. But any
     * future multi-line value embedded in the JSON would silently
     * corrupt on Windows only — preempt that whole class of bug here. */
    _setmode(_fileno(stdout), _O_BINARY);
#endif

    const char *prefix_str = NULL;
    const char *suffix_str = NULL;
    const char *out_path = NULL;
    const char *vrf_blockhash_hex = NULL;
    int thread_count = 0;
    int case_sensitive = 1;
    int quiet = 0;

    for (int i = 1; i < argc; i++) {
        if (strcmp(argv[i], "--prefix") == 0 && i + 1 < argc) {
            prefix_str = argv[++i];
        } else if (strcmp(argv[i], "--suffix") == 0 && i + 1 < argc) {
            suffix_str = argv[++i];
        } else if (strcmp(argv[i], "--threads") == 0 && i + 1 < argc) {
            thread_count = atoi(argv[++i]);
        } else if (strcmp(argv[i], "--out") == 0 && i + 1 < argc) {
            out_path = argv[++i];
        } else if (strcmp(argv[i], "--case-insensitive") == 0) {
            case_sensitive = 0;
        } else if (strcmp(argv[i], "--vrf-blockhash") == 0 && i + 1 < argc) {
            vrf_blockhash_hex = argv[++i];
        } else if (strcmp(argv[i], "--quiet") == 0) {
            quiet = 1;
        } else if (strcmp(argv[i], "--help") == 0 || strcmp(argv[i], "-h") == 0) {
            print_usage(argv[0]); return 0;
        } else {
            fprintf(stderr, "Unknown option: %s\n", argv[i]);
            print_usage(argv[0]); return 1;
        }
    }

    if ((!prefix_str || prefix_str[0] == '\0') &&
        (!suffix_str || suffix_str[0] == '\0')) {
        fprintf(stderr, "Error: --prefix or --suffix is required\n");
        print_usage(argv[0]); return 1;
    }

    if (prefix_str && prefix_str[0] == '\0') prefix_str = NULL;
    if (suffix_str && suffix_str[0] == '\0') suffix_str = NULL;

    int prefix_len = prefix_str ? validate_base58_target("prefix", prefix_str, case_sensitive) : 0;
    if (prefix_len < 0) return 1;
    int suffix_len = suffix_str ? validate_base58_target("suffix", suffix_str, case_sensitive) : 0;
    if (suffix_len < 0) return 1;
    int target_len = prefix_len + suffix_len;

    if (target_len > 44) {
        fprintf(stderr, "Error: combined prefix/suffix too long (max 44 chars)\n");
        return 1;
    }

    if (thread_count <= 0) thread_count = get_cpu_count();
    if (thread_count > 256) thread_count = 256;

    double prob = 1.0;
    for (int i = 0; i < target_len; i++) prob /= 58.0;
    double expected = 1.0 / prob;

    /* Precompute fast-match constants for suffix mode.
     * For case-sensitive: one numeric value.  For case-insensitive:
     * enumerate all 2^k case-variant values.  Falls back to full
     * encode if there are too many variants (> MAX_CASE_VARIANTS). */
    int use_fast_match = 0;
    uint64_t fast_mod = 0;
    int fast_num_variants = 0;
    uint64_t fast_target_vals[MAX_CASE_VARIANTS] = {0};

    if (suffix_len > 0 && suffix_len <= MAX_FAST_TARGET_LEN) {
        fast_mod = pow58(suffix_len);
        if (case_sensitive) {
            int ok = 0;
            fast_target_vals[0] = b58_to_u64(suffix_str, suffix_len, &ok);
            if (ok) { fast_num_variants = 1; use_fast_match = 1; }
        } else {
            fast_num_variants = gen_case_variants(suffix_str, suffix_len,
                                                   fast_target_vals,
                                                   MAX_CASE_VARIANTS);
            if (fast_num_variants > 0) use_fast_match = 1;
        }
    }

    /* VRF: derive master_seed from a VRF proof over the blockhash using
     * a fresh ephemeral keypair, proving the seed was bound to a recent
     * blockhash. Falls back to system entropy if no blockhash given. */
    uint8_t vrf_pk[VRF_PK_BYTES] = {0};
    uint8_t vrf_sk[VRF_SK_BYTES] = {0};
    uint8_t vrf_proof[VRF_PROOF_BYTES] = {0};
    uint8_t vrf_output[VRF_OUTPUT_BYTES] = {0};
    uint8_t vrf_blockhash[32] = {0};
    int use_vrf = 0;

    if (vrf_blockhash_hex) {
        if (hex_decode(vrf_blockhash_hex, vrf_blockhash, 32) != 0) {
            fprintf(stderr, "Error: --vrf-blockhash must be 64 hex chars "
                            "(32 bytes, e.g. a Solana blockhash)\n");
            return 1;
        }
        if (vrf_keygen(vrf_pk, vrf_sk) != 0) {
            fprintf(stderr, "Error: VRF key generation failed\n");
            return 1;
        }
        if (vrf_prove(vrf_proof, vrf_output, vrf_sk,
                       vrf_blockhash, 32) != 0) {
            fprintf(stderr, "Error: VRF prove failed\n");
            return 1;
        }
        use_vrf = 1;
        if (!quiet) {
            fprintf(stderr, "  VRF: seed bound to blockhash (pk: ");
            char tmp[65];
            hex_encode(vrf_pk, 32, tmp);
            fprintf(stderr, "%s", tmp);
            fprintf(stderr, ")\n");
        }
    }

    uint8_t master_seed[32];
    if (use_vrf) {
        memcpy(master_seed, vrf_output, 32);
    } else if (getentropy(master_seed, 32) != 0) {
        fprintf(stderr, "Error: getentropy failed -- cannot generate secure seed\n");
        return 1;
    }

    char target_label[96];
    make_target_label(prefix_str, suffix_str, target_label);

    if (!quiet) {
        if (prefix_str && suffix_str)
            fprintf(stderr, "Vanity Keygen -- grinding for prefix \"%s\" and suffix \"%s\"\n",
                    prefix_str, suffix_str);
        else
            fprintf(stderr, "Vanity Keygen -- grinding for %s: \"%s\"\n",
                    prefix_str ? "prefix" : "suffix",
                    prefix_str ? prefix_str : suffix_str);
        fprintf(stderr, "  Threads: %d  Expected: 1 in 58^%d (%.0f attempts)\n",
                thread_count, target_len, expected);
        fprintf(stderr, "  Rarity tiers: Common <=%.0f  Rare <=%.0f  Legendary <=%.0f  Mythic >%.0f\n",
                expected, expected * 2, expected * 3, expected * 3);
        if (use_fast_match) {
            fprintf(stderr, "  Fast suffix check: pk %% 58^%d (%d case variant%s)\n",
                    suffix_len, fast_num_variants,
                    fast_num_variants == 1 ? "" : "s");
        }
        fprintf(stderr, "  Grinding...\n");
    }

    grind_state_t gs;
    memset(&gs, 0, sizeof(gs));
    atomic_init(&gs.found, false);
    atomic_init(&gs.total_attempts, 0);
    atomic_init(&gs.running_threads, thread_count);
    gs.prefix            = prefix_str;
    gs.prefix_len        = prefix_len;
    gs.suffix            = suffix_str;
    gs.suffix_len        = suffix_len;
    gs.case_sensitive    = case_sensitive;
    gs.attempts_per_thread = (uint64_t)(expected * 4.0 / (double)thread_count) + 1000000;
    gs.use_fast_match    = use_fast_match;
    gs.fast_mod          = fast_mod;
    gs.fast_num_variants = fast_num_variants;
    memcpy(gs.fast_target_vals, fast_target_vals, sizeof(fast_target_vals));
    memcpy(gs.master_seed, master_seed, 32);

    pthread_t *threads = (pthread_t *)calloc((size_t)thread_count, sizeof(pthread_t));
    thread_arg_t *args = (thread_arg_t *)calloc((size_t)thread_count, sizeof(thread_arg_t));
    if (!threads || !args) {
        fprintf(stderr, "Error: malloc failed\n");
        free(threads); free(args); return 1;
    }

    struct timeval t_start;
    gettimeofday(&t_start, NULL);

    for (int i = 0; i < thread_count; i++) {
        args[i].id = i;
        args[i].state = &gs;
        pthread_create(&threads[i], NULL, grind_thread, &args[i]);
    }

    uint64_t last_attempts = 0;
    struct timeval last_tv = t_start;

    while (atomic_load(&gs.running_threads) > 0) {
        usleep(150000);
        if (quiet) continue;

        uint64_t total = atomic_load(&gs.total_attempts);
        struct timeval now;
        gettimeofday(&now, NULL);

        double dt = (double)(now.tv_sec - last_tv.tv_sec) +
                    (double)(now.tv_usec - last_tv.tv_usec) / 1e6;
        if (dt < 0.005) continue;

        uint64_t delta = total - last_attempts;
        double rate = (double)delta / dt;

        const char *pk_str = "";
        if (atomic_exchange(&gs.last_pk_ready, 0))
            pk_str = gs.last_pk;
        fprintf(stderr, "\r  Attempts: %llu  Rate: %.1f K/s  Running: %d threads  Key: %s  ",
                (unsigned long long)total, rate / 1000.0,
                atomic_load(&gs.running_threads), pk_str);
        fflush(stderr);

        last_attempts = total;
        last_tv = now;
    }

    for (int i = 0; i < thread_count; i++)
        pthread_join(threads[i], NULL);

    struct timeval t_end;
    gettimeofday(&t_end, NULL);
    double elapsed = (double)(t_end.tv_sec - t_start.tv_sec) +
                     (double)(t_end.tv_usec - t_start.tv_usec) / 1e6;

    uint64_t total_attempts = atomic_load(&gs.total_attempts);
    rarity_tier_t rarity = classify_rarity(total_attempts, expected);

    if (!quiet) {
        fprintf(stderr, "\r  Done! %llu attempts in %.1fs (%.1f K/s avg)\n",
                (unsigned long long)total_attempts, elapsed,
                (double)total_attempts / elapsed / 1000.0);
        fprintf(stderr, "  Rarity: %s (%.2f epochs)\n\n",
                rarity_name(rarity), (double)total_attempts / expected);
    }

    char pk_b58_output[48];
    b58_of(gs.result_pk, pk_b58_output);

    char json_buf[8192];
    int off = 0;
    off += snprintf(json_buf + off, sizeof(json_buf) - (size_t)off, "{");
    off += snprintf(json_buf + off, sizeof(json_buf) - (size_t)off, "\"secretKey\":[");
    for (int i = 0; i < 64; i++)
        off += snprintf(json_buf + off, sizeof(json_buf) - (size_t)off,
                        "%s%d", i > 0 ? "," : "", gs.result_sk[i]);
    off += snprintf(json_buf + off, sizeof(json_buf) - (size_t)off,
        "],\"publicKey\":\"%s\"", pk_b58_output);
    off += snprintf(json_buf + off, sizeof(json_buf) - (size_t)off,
        ",\"attempts\":%llu", (unsigned long long)total_attempts);
    off += snprintf(json_buf + off, sizeof(json_buf) - (size_t)off,
        ",\"rarity\":\"%s\"", rarity_name(rarity));
    off += snprintf(json_buf + off, sizeof(json_buf) - (size_t)off,
        ",\"epochs\":%.4f", (double)total_attempts / expected);
    off += snprintf(json_buf + off, sizeof(json_buf) - (size_t)off,
        ",\"expectedAttempts\":%.0f", expected);
    off += snprintf(json_buf + off, sizeof(json_buf) - (size_t)off,
        ",\"target\":\"%s\"", target_label);
    if (prefix_str)
        off += snprintf(json_buf + off, sizeof(json_buf) - (size_t)off,
            ",\"prefix\":\"%s\"", prefix_str);
    if (suffix_str)
        off += snprintf(json_buf + off, sizeof(json_buf) - (size_t)off,
            ",\"suffix\":\"%s\"", suffix_str);
    off += snprintf(json_buf + off, sizeof(json_buf) - (size_t)off,
        ",\"targetLen\":%d", target_len);
    off += snprintf(json_buf + off, sizeof(json_buf) - (size_t)off,
        ",\"threads\":%d", thread_count);
    off += snprintf(json_buf + off, sizeof(json_buf) - (size_t)off,
        ",\"elapsedSec\":%.3f", elapsed);
    if (use_vrf) {
        char vrf_proof_hex[VRF_PROOF_BYTES * 2 + 1];
        char vrf_pk_b58[48];
        char vrf_blockhash_b58[48];
        hex_encode(vrf_proof, VRF_PROOF_BYTES, vrf_proof_hex);
        b58_of(vrf_pk, vrf_pk_b58);
        b58_of(vrf_blockhash, vrf_blockhash_b58);
        off += snprintf(json_buf + off, sizeof(json_buf) - (size_t)off,
            ",\"vrfProof\":\"%s\"", vrf_proof_hex);
        off += snprintf(json_buf + off, sizeof(json_buf) - (size_t)off,
            ",\"vrfPk\":\"%s\"", vrf_pk_b58);
        off += snprintf(json_buf + off, sizeof(json_buf) - (size_t)off,
            ",\"vrfBlockhash\":\"%s\"", vrf_blockhash_b58);
    }
    off += snprintf(json_buf + off, sizeof(json_buf) - (size_t)off, "}");

    if (out_path) {
        FILE *f = fopen(out_path, "w");
        if (!f) {
            fprintf(stderr, "Error: cannot write %s\n", out_path);
            free(threads); free(args); return 1;
        }
        fprintf(f, "%s\n", json_buf);
        fclose(f);
    } else {
        printf("%s\n", json_buf);
    }

    if (!quiet) fprintf(stderr, "Address: %s\n", gs.result_b58);
    if (!quiet && out_path) fprintf(stderr, "Keypair saved to: %s\n", out_path);

    free(threads);
    free(args);
    return 0;
}
