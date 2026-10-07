import yaml, sys, pathlib
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / 'dashboard'))
from cockpit_sensor.config import parse_config
c = parse_config(yaml.safe_load(open(pathlib.Path(__file__).with_name('cockpit.example.yaml'))))
print('groups', len(c.groups), 'signals', len(c.signals), 'profiles listed', sum(len(g.profiles) for g in c.groups))
