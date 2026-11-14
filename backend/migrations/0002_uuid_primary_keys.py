import uuid

import backend.models
from django.db import migrations, models


def populate_ids(apps, schema_editor):
    for name, old_key in [('ResearchJob', 'access_token'), ('ResearchCacheEntry', 'key_hash')]:
        model = apps.get_model('backend', name)
        rows = model.objects.using(schema_editor.connection.alias)
        for key in rows.values_list(old_key, flat=True).iterator():
            rows.filter(**{old_key: key}).update(id=uuid.uuid4())


class Migration(migrations.Migration):
    dependencies = [('backend', '0001_initial')]

    operations = [
        migrations.RenameField('researchjob', 'id', 'access_token'),
        migrations.AlterField('researchjob', 'access_token', models.CharField(
            max_length=64, unique=True, default=backend.models.new_access_token, editable=False)),
        migrations.AlterField('researchcacheentry', 'key_hash', models.CharField(max_length=64, unique=True)),
        migrations.AddField('researchjob', 'id', models.UUIDField(null=True, editable=False)),
        migrations.AddField('researchcacheentry', 'id', models.UUIDField(null=True, editable=False)),
        migrations.RunPython(populate_ids, migrations.RunPython.noop),
        migrations.AlterField('researchjob', 'id', models.UUIDField(default=uuid.uuid4, editable=False)),
        migrations.AlterField('researchcacheentry', 'id', models.UUIDField(default=uuid.uuid4, editable=False)),
        migrations.AlterField('researchjob', 'id', models.UUIDField(
            primary_key=True, default=uuid.uuid4, editable=False, serialize=False)),
        migrations.AlterField('researchcacheentry', 'id', models.UUIDField(
            primary_key=True, default=uuid.uuid4, editable=False, serialize=False)),
    ]
