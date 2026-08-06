use tree_sitter::Parser;
use tree_sitter_typescript::LANGUAGE_TSX;

use crate::graph::{Edge, Location, NodeId, Symbol, SymbolGraph, SymbolKind};

pub fn make_ts_parser() -> Parser {
    let mut parser = Parser::new();
    parser
        .set_language(&LANGUAGE_TSX.into())
        .expect("failed to load TypeScript TSX grammar");
    parser
}

pub fn parse_document(
    source: &str,
    file_path: &str,
    next_id: &mut NodeId,
) -> SymbolGraph {
    let mut parser = make_ts_parser();
    let tree = parser.parse(source, None).expect("parse failed");
    let root = tree.root_node();
    let mut symbols = Vec::new();
    let mut edges = Vec::new();

    walk_ts_node(root, source, file_path, None, next_id, &mut symbols, &mut edges);

    SymbolGraph {
        files_indexed: 1,
        total_symbols: symbols.len(),
        symbols,
        edges,
    }
}

fn walk_ts_node(
    node: tree_sitter::Node,
    source: &str,
    file_path: &str,
    parent_id: Option<NodeId>,
    next_id: &mut NodeId,
    symbols: &mut Vec<Symbol>,
    _edges: &mut Vec<Edge>,
) {
    let node_kind = classify_ts_kind(node.kind());

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
            walk_ts_node(child, source, file_path, None, next_id, symbols, _edges);
            if !cursor.goto_next_sibling() {
                break;
            }
        }
    }
}

fn classify_ts_kind(kind: &str) -> SymbolKind {
    match kind {
        "function_declaration" | "function_expression" | "arrow_function" => SymbolKind::Function,
        "class_declaration" | "class_expression" => SymbolKind::Class,
        "method_definition" => SymbolKind::Method,
        "variable_declarator" | "lexical_declaration" => SymbolKind::Variable,
        "const_declaration" | "variable_declaration" => SymbolKind::Const,
        "interface_declaration" => SymbolKind::Interface,
        "type_alias_declaration" => SymbolKind::TypeAlias,
        "enum_declaration" => SymbolKind::Enum,
        "import_statement" | "import" => SymbolKind::Import,
        "export_statement" | "export" => SymbolKind::Export,
        "pair" | "property_signature" => SymbolKind::Property,
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