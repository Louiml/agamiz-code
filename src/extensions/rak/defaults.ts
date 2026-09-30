/**
 * Defaults contributed by the Rak extension. The default editor buffer and the
 * suggested file extension for a brand-new scratch file are Rak-provided so the
 * Agamiz Code core does not hardcode any language.
 */
export const RAK_EXTENSION = 'rak';

export const RAK_DEFAULT_CODE = `// Rak v0.4 — pipeline, regex, binary patterns, traits!
// Run: Ctrl+R   Terminal: Ctrl+Shift+T   Palette: Ctrl+Shift+P

// Pipeline operator |>
fn inc(n) { return n + 1 }
fn dbl(n) { return n * 2 }
dump 5 |> inc |> dbl        // 12

// Regex literals /pattern/flags
let re = /\\d+/g
dump re.find_all("a1 b22 c333")   // [1, 22, 333]

// Traits: Display drives dump
struct Point { x: int, y: int }
impl Display for Point {
    fn fmt(self) { return fmt("({}, {})", self.x, self.y) }
}
dump Point { x: 3, y: 4 }   // (3, 4)
`;