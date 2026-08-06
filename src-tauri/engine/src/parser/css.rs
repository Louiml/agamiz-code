use tree_sitter::Parser;
use tree_sitter_css::LANGUAGE;
use crate::graph::{Edge, Location, NodeId, Symbol, SymbolGraph, SymbolKind};

pub fn parse_document(
    source: &str,
    file_path: &str,
    base_id: &mut NodeId,
) -> SymbolGraph {
    let mut parser = Parser::new();
    parser
        .set_language(&LANGUAGE.into())
        .expect("failed to load CSS grammar");
    let tree = parser.parse(source, None).expect("parse failed");
    let root = tree.root_node();
    let mut symbols = Vec::new();
    let mut edges = Vec::new();

    walk_css_node(root, source, file_path, base_id, &mut symbols);

    SymbolGraph {
        files_indexed: 1,
        total_symbols: symbols.len(),
        symbols,
        edges,
    }
}

fn walk_css_node(
    node: tree_sitter::Node,
    source: &str,
    file_path: &str,
    next_id: &mut NodeId,
    symbols: &mut Vec<Symbol>,
) {
    match node.kind() {
        "rule_set" | "selector" | "class_selector" | "id_selector"
        | "declaration" | "at_rule" => {
            let id = *next_id;
            *next_id += 1;
            let start = node.start_position();
            let end = node.end_position();
            let name = node.utf8_text(source.as_bytes()).unwrap_or("").to_string();
            symbols.push(Symbol {
                id,
                name,
                kind: SymbolKind::Unknown,
                location: Location {
                    file: std::path::PathBuf::from(file_path),
                    row: start.row + 1,
                    col: start.column,
                    end_row: end.row + 1,
                    end_col: end.column,
                },
                parent_id: None,
            });
        }
        _ => {}
    }

    let mut cursor = node.walk();
    if cursor.goto_first_child() {
        loop {
            let child = cursor.node();
            walk_css_node(child, source, file_path, next_id, symbols);
            if !cursor.goto_next_sibling() {
                break;
            }
        }
    }
}