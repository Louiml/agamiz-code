use tree_sitter::Parser;
use tree_sitter_rust::LANGUAGE;

use crate::graph::{Edge, Location, NodeId, Symbol, SymbolGraph, SymbolKind};

pub fn parse_document(
    source: &str,
    file_path: &str,
    next_id: &mut NodeId,
) -> SymbolGraph {
    let mut parser = Parser::new();
    parser
        .set_language(&LANGUAGE.into())
        .expect("failed to load Rust grammar");
    let tree = parser.parse(source, None).expect("parse failed");
    let root = tree.root_node();
    let mut symbols = Vec::new();
    let mut edges = Vec::new();

    walk_rs_node(root, source, file_path, None, next_id, &mut symbols, &mut edges);

    SymbolGraph {
        files_indexed: 1,
        total_symbols: symbols.len(),
        symbols,
        edges,
    }
}

fn walk_rs_node(
    node: tree_sitter::Node,
    source: &str,
    file_path: &str,
    parent_id: Option<NodeId>,
    next_id: &mut NodeId,
    symbols: &mut Vec<Symbol>,
    _edges: &mut Vec<Edge>,
) {
    let node_kind = classify_rs_kind(node.kind());

    if !matches!(node_kind, SymbolKind::Unknown) {
        let id = *next_id;
        *next_id += 1;

        let start = node.start_position();
        let end_pos = node.end_position();
        let name = extract_name(source, &node);

        symbols.push(Symbol {
            id,
            name,
            kind: node_kind,
            location: Location {
                file: std::path::PathBuf::from(file_path),
                row: start.row + 1,
                col: start.column,
                end_row: end_pos.row + 1,
                end_col: end_pos.column,
            },
            parent_id,
        });
    }

    let mut cursor = node.walk();
    if cursor.goto_first_child() {
        loop {
            let child = cursor.node();
            walk_rs_node(child, source, file_path, None, next_id, symbols, _edges);
            if !cursor.goto_next_sibling() {
                break;
            }
        }
    }
}

fn classify_rs_kind(kind: &str) -> SymbolKind {
    match kind {
        "function_item" => SymbolKind::Function,
        "struct_item" => SymbolKind::Class,
        "enum_item" => SymbolKind::Enum,
        "trait_item" => SymbolKind::Interface,
        "type_item" | "type_alias_item" | "type" => SymbolKind::TypeAlias,
        "impl_item" => SymbolKind::Class,
        "const_item" => SymbolKind::Const,
        "static_item" => SymbolKind::Variable,
        "let_declaration" | "identifier" => SymbolKind::Variable,
        "use_declaration" => SymbolKind::Import,
        "mod_item" => SymbolKind::Module,
        "field_declaration" => SymbolKind::Property,
        "parameter" => SymbolKind::Parameter,
        "macro_definition" => SymbolKind::Function,
        _ => SymbolKind::Unknown,
    }
}

fn extract_name(source: &str, node: &tree_sitter::Node) -> String {
    if let Some(name_node) = node.child_by_field_name("name") {
        return name_node.utf8_text(source.as_bytes()).unwrap_or("").to_string();
    }
    node.utf8_text(source.as_bytes())
        .unwrap_or("")
        .lines()
        .next()
        .unwrap_or("")
        .trim()
        .to_string()
}