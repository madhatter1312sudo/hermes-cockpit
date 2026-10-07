"""hermes-cockpit — agent/plugin-package half.

The PluginManager imports this directory as a Python package; without an
``__init__.py`` it fails with "No __init__.py in <dir>" (seen in errors.log).
The dashboard API (``dashboard/plugin_api.py``) mounts independently of this
file; the desktop half (``desktop/plugin.js``) is a separate install.
"""


def register(ctx):
    """No agent tools or hooks; the sensor serves via the dashboard API."""
