"""cockpit_sensor — reads the state Hermes keeps on disk and turns it into one fleet picture.

Runs inside the gateway process (imported by ``dashboard/plugin_api.py``). Every read is
read-only SQLite / JSON / file-mtime; nothing here writes to Hermes state except the one
opt-in kanban card creation in :mod:`actions`.

Honours ``HERMES_HOME`` (never ``Path.home()``), so tests can point it at a synthetic home.
"""

from .config import CockpitConfig, load_config
from .fleet import Sensor

__all__ = ["CockpitConfig", "load_config", "Sensor"]
__version__ = "0.1.0"
