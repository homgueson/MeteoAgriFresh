# -*- coding: utf-8 -*-
"""
generate_aprx_zd.py
====================
Génère un projet ArcGIS Pro (.aprx) pour chaque commune en ajoutant les
couches provenant de la GDB PIAO et de la GDB Resultats.

Couches ajoutées (dans l'ordre) :
  Route   ← Reseau_Routier  (GDB PIAO — racine ou feature dataset)
  Blocs   ← Blocs           (GDB PIAO — racine ou feature dataset)
  ZD      ← ZD_<commune>*   (GDB PIAO — racine ou feature dataset)
  Hydro   ← Hydro           (GDB PIAO — racine ou feature dataset)
  IS      ← R_<commune>*    (GDB Resultats — racine ou feature dataset)

Correction apportée :
  La fonction find_fc_in_gdb() résout le chemin complet d'une feature class
  en cherchant d'abord à la racine de la GDB puis dans chaque feature
  dataset qu'elle contient.  Cela évite l'erreur trompeuse
  « Failed to add data. Possible credentials issue. » qui survenait lorsque
  le chemin transmis à addDataFromPath() était incomplet.
"""

import argparse
import os
import sys
import arcpy

# ---------------------------------------------------------------------------
# Defaults — overridable via CLI arguments or environment variables.
# CLI flags take precedence over env vars; env vars take precedence over the
# compiled-in defaults below.
#
# Usage examples :
#   python generate_aprx_zd.py --workspace D:\Projets\ZD --template D:\tpl\vide.aprx
#   ZD_WORKSPACE=D:\Projets\ZD python generate_aprx_zd.py
# ---------------------------------------------------------------------------

_DEFAULT_WORKSPACE = r"C:\ProjetZD"
_DEFAULT_TEMPLATE  = r"C:\ProjetZD\templates\template_vide.aprx"
_DEFAULT_MAP_NAME  = "Map"

# Module-level name used by process_commune(); overwritten by _parse_args().
TEMPLATE_MAP_NAME = os.environ.get("ZD_TEMPLATE_MAP_NAME", _DEFAULT_MAP_NAME)

# ---------------------------------------------------------------------------
# Helpers de journalisation
# ---------------------------------------------------------------------------

OK   = "  \u2714 "  # ✔
WARN = "  \u26a0  "  # ⚠
ERR  = "  \u2718  "  # ✘
HEAD = "\u2550\u2550  "  # ══


def log_ok(msg):
    print(f"{OK}{msg}")


def log_warn(msg):
    print(f"{WARN}{msg}")


def log_err(msg):
    print(f"{ERR}{msg}")


def log_head(msg):
    print(f"\n{HEAD}{msg}")


# ---------------------------------------------------------------------------
# Fonction clé : résolution robuste d'une feature class dans une GDB
# ---------------------------------------------------------------------------

def find_fc_in_gdb(gdb_path, fc_name):
    """Retourne le chemin complet d'une feature class dans *gdb_path*.

    L'algorithme cherche dans cet ordre :
      1. Directement à la racine de la GDB  : <gdb_path>/<fc_name>
      2. Dans chaque feature dataset        : <gdb_path>/<dataset>/<fc_name>

    Paramètres
    ----------
    gdb_path : str
        Chemin absolu vers le fichier .gdb (ou toute GDB arcpy valide).
    fc_name : str
        Nom exact de la feature class (sans chemin).

    Retourne
    --------
    str | None
        Chemin complet si trouvé, None sinon.
    """
    if not arcpy.Exists(gdb_path):
        log_err(f"GDB introuvable : {gdb_path}")
        return None

    # 1) Racine
    root_path = os.path.join(gdb_path, fc_name)
    if arcpy.Exists(root_path):
        log_ok(f"'{fc_name}' trouvé à la racine : {root_path}")
        return root_path

    # 2) Feature datasets
    prev_ws = arcpy.env.workspace
    try:
        arcpy.env.workspace = gdb_path
        datasets = arcpy.ListDatasets(feature_type="Feature") or []
    finally:
        arcpy.env.workspace = prev_ws

    for ds in datasets:
        ds_path = os.path.join(gdb_path, ds)
        fc_path = os.path.join(ds_path, fc_name)
        if arcpy.Exists(fc_path):
            log_ok(f"'{fc_name}' trouvé dans le dataset '{ds}' : {fc_path}")
            return fc_path

    log_err(f"'{fc_name}' introuvable dans la GDB : {gdb_path}")
    return None


# ---------------------------------------------------------------------------
# Helpers : recherche par préfixe et ajout de couche
# ---------------------------------------------------------------------------

def find_fc_by_prefix_in_gdb(gdb_path, prefix):
    """Cherche la première feature class dont le nom commence par *prefix*
    (insensible à la casse) en balayant la racine puis les feature datasets.

    Retourne ``(fc_name, full_path)`` ou ``(None, None)``.
    """
    if not arcpy.Exists(gdb_path):
        log_err(f"GDB introuvable : {gdb_path}")
        return None, None

    prev_ws = arcpy.env.workspace
    try:
        arcpy.env.workspace = gdb_path
        root_fcs = arcpy.ListFeatureClasses() or []
        datasets  = arcpy.ListDatasets(feature_type="Feature") or []
    finally:
        arcpy.env.workspace = prev_ws

    prefix_lower = prefix.lower()

    # Racine
    for fc in root_fcs:
        if fc.lower().startswith(prefix_lower):
            full = os.path.join(gdb_path, fc)
            return fc, full

    # Feature datasets
    for ds in datasets:
        prev_ws = arcpy.env.workspace
        try:
            arcpy.env.workspace = os.path.join(gdb_path, ds)
            ds_fcs = arcpy.ListFeatureClasses() or []
        finally:
            arcpy.env.workspace = prev_ws
        for fc in ds_fcs:
            if fc.lower().startswith(prefix_lower):
                full = os.path.join(gdb_path, ds, fc)
                return fc, full

    return None, None


def add_layer(aprx_map, layer_alias, full_path):
    """Ajoute une feature class à la carte et retourne l'objet Layer ou None."""
    if full_path is None:
        return None
    try:
        aprx_map.addDataFromPath(full_path)
        layers = aprx_map.listLayers()
        if not layers:
            log_err(f"Couche '{layer_alias}' ajoutée mais introuvable dans la carte.")
            return None
        # La couche ajoutée est la première de la liste (ajout en tête)
        added = layers[0]
        added.name = layer_alias
        log_ok(f"Couche ajoutée : {layer_alias}  \u2190  {os.path.basename(full_path)}")
        return added
    except Exception as exc:
        log_err(f"Erreur ajout '{layer_alias}' ({full_path}) : {exc}")
        return None


# ---------------------------------------------------------------------------
# Application de la symbologie via CIM
# ---------------------------------------------------------------------------

def _make_simple_fill_cim(fill_color_rgba, outline_color_rgba, outline_width):
    """Construit un CIMSymbolReference pour un polygone à remplissage simple."""
    sym = arcpy.cim.CreateCIMObjectFromClassName("CIMPolygonSymbol", "V3")
    layer_fill = arcpy.cim.CreateCIMObjectFromClassName("CIMSolidFill", "V3")
    layer_fill.enable = True
    layer_fill.color = _rgba_to_cim_color(fill_color_rgba)

    layer_stroke = arcpy.cim.CreateCIMObjectFromClassName("CIMSolidStroke", "V3")
    layer_stroke.enable = True
    layer_stroke.width = outline_width
    layer_stroke.color = _rgba_to_cim_color(outline_color_rgba)

    sym.symbolLayers = [layer_fill, layer_stroke]
    ref = arcpy.cim.CreateCIMObjectFromClassName("CIMSymbolReference", "V3")
    ref.symbol = sym
    return ref


def _rgba_to_cim_color(rgba):
    """Convertit un tuple (R, G, B, A 0-100) en objet CIMRGBColor."""
    r, g, b, a = rgba
    color = arcpy.cim.CreateCIMObjectFromClassName("CIMRGBColor", "V3")
    color.R = r
    color.G = g
    color.B = b
    color.alpha = a  # 0 = transparent, 100 = opaque
    return color


def apply_symbology_polygon(layer, fill_rgba, outline_rgba, outline_width):
    """Applique une symbologie de remplissage simple sur un layer polygone via CIM."""
    try:
        cim_lyr = layer.getDefinition("V3")
        sym_ref = _make_simple_fill_cim(fill_rgba, outline_rgba, outline_width)
        cim_lyr.renderer.symbol = sym_ref
        layer.setDefinition(cim_lyr)
        log_ok(
            f"Symbologie {layer.name} (fond transparent, contour "
            f"rgb{outline_rgba[:3]} ép.{outline_width}) appliquée via CIM."
        )
    except Exception as exc:
        log_warn(f"Symbologie {layer.name} non appliquée : {exc}")


# Couleur « Yucca Yellow » ArcGIS Pro
YUCCA_YELLOW = (255, 234, 0, 100)   # R G B alpha=opaque
GREY_OUTLINE  = (110, 110, 110, 100)
TRANSPARENT   = (0,   0,   0,   0)   # alpha=0 → transparent


# ---------------------------------------------------------------------------
# Application des étiquettes via CIM
# ---------------------------------------------------------------------------

def apply_labels_blocs(layer):
    """Active les étiquettes sur la couche Blocs (champ ID_Ilot, Tahoma 18,
    halo blanc ép.2, positionnement intérieur polygone)."""
    try:
        cim_lyr = layer.getDefinition("V3")

        lc = arcpy.cim.CreateCIMObjectFromClassName("CIMLabelClass", "V3")
        lc.name             = "Ilot"
        lc.expression       = "$feature.ID_Ilot"
        lc.expressionEngine = "Arcade"
        lc.visibility       = True

        # Symbole texte
        txt_sym = arcpy.cim.CreateCIMObjectFromClassName("CIMTextSymbol", "V3")
        txt_sym.fontFamilyName = "Tahoma"
        txt_sym.height         = 18

        halo = arcpy.cim.CreateCIMObjectFromClassName("CIMPolygonSymbol", "V3")
        halo_fill = arcpy.cim.CreateCIMObjectFromClassName("CIMSolidFill", "V3")
        halo_fill.enable = True
        halo_fill.color  = _rgba_to_cim_color((255, 255, 255, 100))
        halo.symbolLayers = [halo_fill]
        txt_sym.haloSymbol = halo
        txt_sym.haloSize   = 2

        sym_ref = arcpy.cim.CreateCIMObjectFromClassName("CIMSymbolReference", "V3")
        sym_ref.symbol = txt_sym
        lc.textSymbol  = sym_ref

        # Placement intérieur polygone
        placement = arcpy.cim.CreateCIMObjectFromClassName(
            "CIMStandardLabelPlacementProperties", "V3"
        )
        placement.pointPlacementMethod = "OnTopPoint"
        lc.standardLabelPlacementProperties = placement

        cim_lyr.labelClasses  = [lc]
        cim_lyr.labelVisibility = True
        layer.setDefinition(cim_lyr)
        log_ok(
            "Étiquettes Blocs activées : champ ID_Ilot, intérieur polygones, "
            "Tahoma 18, halo blanc ép.2."
        )
    except Exception as exc:
        log_warn(f"Étiquettes Blocs non appliquées : {exc}")


# ---------------------------------------------------------------------------
# Traitement d'une commune
# ---------------------------------------------------------------------------

def process_commune(commune_name, commune_dir, template_aprx):
    """Génère le projet .aprx pour une commune donnée."""
    log_head(f"COMMUNE : {commune_name}")

    aprx_name = f"ZD_{commune_name}.aprx"
    aprx_path = os.path.join(commune_dir, aprx_name)

    # --- Création / remplacement du projet ---
    if os.path.exists(aprx_path):
        log_warn(f"Projet existant — remplacement : {aprx_name}")
        os.remove(aprx_path)

    try:
        aprx_template = arcpy.mp.ArcGISProject(template_aprx)
        aprx_template.saveACopy(aprx_path)
        log_ok(f"Fichier .aprx créé (template ArcGIS Pro)")
    except Exception as exc:
        log_err(f"Impossible de créer le projet : {exc}")
        return

    aprx = arcpy.mp.ArcGISProject(aprx_path)

    # --- Renommage de la carte ---
    maps = aprx.listMaps(TEMPLATE_MAP_NAME)
    if maps:
        carte = maps[0]
        carte.name = f"ZD_{commune_name}"
        log_ok(f"Carte renommée : '{carte.name}'")
    else:
        all_maps = aprx.listMaps()
        if not all_maps:
            log_err("Aucune carte trouvée dans le projet — arrêt du traitement.")
            return
        carte = all_maps[0]
        log_warn(
            f"Carte '{TEMPLATE_MAP_NAME}' introuvable — "
            f"utilisation de la première carte disponible : '{carte.name}'"
        )

    # --- GDB PIAO ---
    gdb_piao = _find_gdb(commune_dir, prefix="PIAO_")
    if gdb_piao is None:
        log_err(f"GDB PIAO introuvable dans : {commune_dir}")
        aprx.save()
        return
    log_ok(f"GDB PIAO : {os.path.basename(gdb_piao)}")

    # -- Route (Reseau_Routier) --
    route_path = find_fc_in_gdb(gdb_piao, "Reseau_Routier")
    lyr_route = add_layer(carte, "Route", route_path)

    # -- Blocs --
    blocs_path = find_fc_in_gdb(gdb_piao, "Blocs")
    lyr_blocs  = add_layer(carte, "Blocs", blocs_path)

    # -- ZD (préfixe variable selon la commune) --
    zd_prefix    = f"ZD_{commune_name}"
    zd_fc, zd_path = find_fc_by_prefix_in_gdb(gdb_piao, zd_prefix)
    if zd_fc:
        log_ok(f"Couche ZD trouvée : {zd_fc}")
    else:
        log_err(f"Couche ZD introuvable (préfixe '{zd_prefix}') dans {os.path.basename(gdb_piao)}")
    lyr_zd = add_layer(carte, "ZD", zd_path)

    # -- Hydro --
    hydro_path = find_fc_in_gdb(gdb_piao, "Hydro")
    lyr_hydro  = add_layer(carte, "Hydro", hydro_path)

    # --- GDB Resultats ---
    gdb_res = _find_gdb(commune_dir, exact="Resultats.gdb")
    if gdb_res:
        log_ok(f"GDB Resultats : {os.path.basename(gdb_res)}")
        # IS : préfixe « R_ »
        is_prefix = "R_"
        is_fc, is_path = find_fc_by_prefix_in_gdb(gdb_res, is_prefix)
        if is_fc:
            log_ok(f"Image IS trouvée dans Resultats.gdb : {is_fc}")
        else:
            log_err(f"Image IS introuvable (préfixe '{is_prefix}') dans Resultats.gdb")
        lyr_is = add_layer(carte, "IS", is_path)
    else:
        log_warn("GDB Resultats introuvable — couche IS ignorée.")

    # --- Sauvegarde intermédiaire ---
    try:
        aprx.save()
        log_ok("Sauvegarde intermédiaire avant symbologies.")
    except Exception as exc:
        log_warn(f"Sauvegarde intermédiaire échouée : {exc}")

    # --- Symbologies ---
    if lyr_zd:
        apply_symbology_polygon(lyr_zd,   TRANSPARENT,   GREY_OUTLINE,  1)
    if lyr_blocs:
        apply_symbology_polygon(lyr_blocs, TRANSPARENT,  YUCCA_YELLOW,  4)
        apply_labels_blocs(lyr_blocs)

    # --- Sauvegarde finale ---
    try:
        aprx.save()
        log_ok(f"Projet sauvegardé : {aprx_name}")
    except Exception as exc:
        log_err(f"Erreur lors de la sauvegarde finale : {exc}")

    del aprx


# ---------------------------------------------------------------------------
# Utilitaires
# ---------------------------------------------------------------------------

def _find_gdb(directory, prefix=None, exact=None):
    """Cherche un fichier .gdb dans *directory* par nom exact ou préfixe."""
    try:
        entries = os.listdir(directory)
    except OSError:
        return None
    for entry in entries:
        if not entry.lower().endswith(".gdb"):
            continue
        if exact and entry == exact:
            return os.path.join(directory, entry)
        if prefix and entry.startswith(prefix):
            return os.path.join(directory, entry)
    return None


def list_communes(workspace):
    """Retourne la liste des (commune_name, commune_dir) à traiter."""
    communes = []
    try:
        for entry in sorted(os.listdir(workspace)):
            full = os.path.join(workspace, entry)
            if os.path.isdir(full):
                communes.append((entry.upper(), full))
    except OSError as exc:
        log_err(f"Impossible de lister le workspace : {exc}")
    return communes


# ---------------------------------------------------------------------------
# Point d'entrée
# ---------------------------------------------------------------------------

def _parse_args():
    """Parse CLI arguments; env vars are used as fallbacks for defaults."""
    parser = argparse.ArgumentParser(
        description="Génère un projet ArcGIS Pro (.aprx) par commune."
    )
    parser.add_argument(
        "--workspace",
        default=os.environ.get("ZD_WORKSPACE", _DEFAULT_WORKSPACE),
        help=(
            "Répertoire racine contenant un sous-dossier par commune "
            "(défaut : env ZD_WORKSPACE ou %(default)s)"
        ),
    )
    parser.add_argument(
        "--template",
        default=os.environ.get("ZD_TEMPLATE", _DEFAULT_TEMPLATE),
        help=(
            "Chemin vers le fichier .aprx template "
            "(défaut : env ZD_TEMPLATE ou %(default)s)"
        ),
    )
    parser.add_argument(
        "--map-name",
        default=os.environ.get("ZD_TEMPLATE_MAP_NAME", _DEFAULT_MAP_NAME),
        help="Nom de la carte dans le template (défaut : %(default)s)",
    )
    return parser.parse_args()


def main():
    global TEMPLATE_MAP_NAME

    args = _parse_args()
    workspace_root  = args.workspace
    template_aprx   = args.template
    TEMPLATE_MAP_NAME = args.map_name

    communes = list_communes(workspace_root)
    if not communes:
        log_err(f"Aucune commune trouvée dans : {workspace_root}")
        sys.exit(1)

    for commune_name, commune_dir in communes:
        try:
            process_commune(commune_name, commune_dir, template_aprx)
        except Exception as exc:
            log_err(f"Erreur inattendue pour {commune_name} : {exc}")


if __name__ == "__main__":
    main()
