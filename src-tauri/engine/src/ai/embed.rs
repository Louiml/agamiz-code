//! Local, dependency-free code embeddings.
//!
//! Produces a fixed-size hashed feature vector from source code using token
//! n-grams (feature hashing). This runs entirely on-device, is deterministic,
//! and needs no model weights — well suited for fast hybrid retrieval in a
//! local workspace vector store.

/// Vector width for all chunk and query embeddings.
pub const DIM: usize = 256;

/// FNV-1a 32-bit hash used for feature hashing.
fn fvn1a(bytes: &[u8]) -> u32 {
    let mut h: u32 = 0x811c_9dc5;
    for &b in bytes {
        h ^= b as u32;
        h = h.wrapping_mul(0x0100_0193);
    }
    h
}

/// Lowercase, identifier-aware word splitting. Keeps alphanumeric runs and
/// common code tokens so "loadUsers" == "load_users" == "load users".
fn tokens(text: &str) -> Vec<String> {
    let lower = text.to_lowercase();
    let mut out = Vec::new();
    let mut cur = String::new();
    let flush = |cur: &mut String, out: &mut Vec<String>| {
        if !cur.is_empty() {
            out.push(std::mem::take(cur));
        }
    };
    for ch in lower.chars() {
        if ch.is_alphanumeric() {
            cur.push(ch);
        } else {
            flush(&mut cur, &mut out);
            // Keep structural symbols as their own token.
            if ch == '_' || ch == '.' || ch == ':' || ch == '/' {
                out.push(ch.to_string());
            }
        }
    }
    flush(&mut cur, &mut out);
    out
}

/// Hash a token, optionally into a band, producing a signed contribution into
/// `vec[|hash| % dim]`.
fn hash_in(vec: &mut Vec<f32>, token: &str, band: u32) {
    let h = fvn1a(format!("{band}:{token}").as_bytes()) as usize;
    let idx = h % DIM;
    let sign = if (h as i64) & 1 == 1 { 1.0 } else { -1.0 };
    vec[idx] += sign * (1.0 + (h % 3) as f32);
}

/// Produce a normalized code embedding for `text`.
pub fn embed(text: &str) -> Vec<f32> {
    let toks = tokens(text);
    let mut vec = vec![0f32; DIM];
    let n = toks.len();
    for (i, tok) in toks.iter().enumerate() {
        // Unigram, bigram and trigram features.
        hash_in(&mut vec, tok, 0);
        if i + 1 < n {
            hash_in(&mut vec, &format!("{} {}", tok, toks[i + 1]), 1);
        }
        if i + 2 < n {
            hash_in(
                &mut vec,
                &format!("{} {} {}", tok, toks[i + 1], toks[i + 2]),
                2,
            );
        }
    }
    normalize(&mut vec);
    vec
}

/// L2 normalization in place (no-op for the empty vector).
pub fn normalize(v: &mut Vec<f32>) {
    let norm: f32 = v.iter().map(|x| x * x).sum::<f32>().sqrt();
    if norm > 1e-6 {
        for x in v.iter_mut() {
            *x /= norm;
        }
    }
}

/// Cosine similarity between two normalized vectors of `DIM` length.
pub fn cosine(a: &[f32], b: &[f32]) -> f32 {
    a.iter()
        .zip(b.iter())
        .fold(0f32, |acc, (x, y)| acc + x * y)
}

/// Encode the vector to a persisted byte array.
pub fn to_bytes(v: &[f32]) -> Vec<u8> {
    let mut out = Vec::with_capacity(v.len() * 4);
    for x in v {
        out.extend_from_slice(&x.to_le_bytes());
    }
    out
}

/// Decode a persisted byte array back into a vector.
pub fn from_bytes(b: &[u8]) -> Vec<f32> {
    b.chunks_exact(4)
        .map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn same_text_same_vec() {
        let a = embed("fn foo(bar) { return bar + 1; }");
        let b = embed("fn foo(bar) { return bar + 1; }");
        assert!((cosine(&a, &b) - 1.0).abs() < 1e-4);
    }

    #[test]
    fn similar_text_high_cosine() {
        let a = embed("fn getUser(id) { return users[id]; }");
        let b = embed("function getUser(userId) { return collection[userId]; }");
        let c = embed("const colorTheme = '#333';");
        let sim = cosine(&a, &b);
        let noise = cosine(&a, &c);
        assert!(sim > noise);
        assert!(sim > 0.2);
    }

    #[test]
    fn roundtrip_bytes() {
        let v = embed("hello world");
        let back = from_bytes(&to_bytes(&v));
        assert_eq!(v, back);
    }
}