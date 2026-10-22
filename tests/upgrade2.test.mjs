/**
 * CI Craft Upgrade 2.0 contract tests.
 *
 * These exercise the real client weapon catalog and pure storm schedule,
 * then verify that the Node server mirrors the combat/storm numbers instead
 * of trusting client-submitted damage or using a second faster zone timer.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function loadUpgradeModules() {
  const tmpDir = fs.mkdtempSync(path.join(ROOT_DIR, '.upgrade2-test-'));
  const emit = (source, output, replacements = []) => {
    let code = stripTypeScriptTypes(fs.readFileSync(path.join(ROOT_DIR, source), 'utf8'));
    for (const [pattern, replacement] of replacements) {
      code = code.replace(pattern, replacement);
    }
    fs.writeFileSync(path.join(tmpDir, output), code);
  };

  try {
    emit('src/network/schemas.ts', 'schemas.mjs');
    emit('src/weapons/WeaponDefinitions.ts', 'WeaponDefinitions.mjs', [
      [/import\s+\{[\s\S]*?\}\s+from\s+['"]\.\.\/network\/schemas['"];?\n?/, ''],
    ]);
    emit('src/systems/StormConfig.ts', 'StormConfig.mjs', [
      [/import\s+type\s+\{[\s\S]*?\}\s+from\s+['"]\.\.\/network\/schemas['"];?\n?/, ''],
    ]);

    const weapons = await import(
      pathToFileURL(path.join(tmpDir, 'WeaponDefinitions.mjs')).href
    );
    const storm = await import(pathToFileURL(path.join(tmpDir, 'StormConfig.mjs')).href);
    return { weapons, storm };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

test('Upgrade 2.0 weapons: nine firearm archetypes are complete and bounded', async () => {
  const { weapons } = await loadUpgradeModules();
  const {
    FIREARM_CATEGORIES,
    calculateWeaponDamage,
    createWeaponMesh,
    createWeaponStats,
  } = weapons;

  assert.deepEqual(FIREARM_CATEGORIES, [
    'pistol',
    'heavy_pistol',
    'assault_rifle',
    'burst_rifle',
    'dmr',
    'shotgun',
    'tactical_shotgun',
    'smg',
    'sniper',
  ]);

  const expectedCommon = {
    pistol: { damage: 22, ammoType: 'light', pellets: 1, range: 125 },
    heavy_pistol: { damage: 40, ammoType: 'heavy', pellets: 1, range: 145 },
    assault_rifle: { damage: 24, ammoType: 'medium', pellets: 1, range: 190 },
    burst_rifle: { damage: 24, ammoType: 'medium', pellets: 1, range: 205 },
    dmr: { damage: 42, ammoType: 'medium', pellets: 1, range: 275 },
    shotgun: { damage: 11, ammoType: 'shells', pellets: 8, range: 46 },
    tactical_shotgun: { damage: 8, ammoType: 'shells', pellets: 8, range: 52 },
    smg: { damage: 16, ammoType: 'light', pellets: 1, range: 95 },
    sniper: { damage: 84, ammoType: 'heavy', pellets: 1, range: 340 },
  };
  const rarities = ['common', 'uncommon', 'rare', 'epic', 'legendary'];
  const ids = new Set();

  for (const category of FIREARM_CATEGORIES) {
    let previousDamage = 0;
    for (const rarity of rarities) {
      const stats = createWeaponStats(category, rarity);
      assert.equal(stats.category, category);
      assert.equal(stats.rarity, rarity);
      assert.ok(!ids.has(stats.id), `duplicate weapon id ${stats.id}`);
      ids.add(stats.id);
      assert.ok(stats.baseDamage >= previousDamage, `${stats.id} rarity damage regressed`);
      previousDamage = stats.baseDamage;
      assert.ok(stats.clipSize > 0 && stats.reloadTime > 0 && stats.range > 0);
      assert.ok(calculateWeaponDamage(stats, true) >= calculateWeaponDamage(stats, false));

      const burstShots = stats.fireMode === 'burst' ? stats.burstCount : 1;
      const commonDps =
        createWeaponStats(category, 'common').baseDamage *
        stats.pellets *
        stats.fireRate *
        burstShots;
      assert.ok(commonDps <= 175, `${category} common DPS is unbounded: ${commonDps}`);
    }

    const common = createWeaponStats(category, 'common');
    assert.equal(common.baseDamage, expectedCommon[category].damage, category);
    assert.equal(common.ammoType, expectedCommon[category].ammoType, category);
    assert.equal(common.pellets, expectedCommon[category].pellets, category);
    assert.equal(common.range, expectedCommon[category].range, category);

    const mesh = createWeaponMesh(category, 'legendary');
    let muzzleCount = 0;
    mesh.traverse((child) => {
      if (child.name === 'muzzle_tip') muzzleCount++;
    });
    assert.equal(muzzleCount, 1, `${category} mesh needs exactly one muzzle anchor`);
  }

  const burst = createWeaponStats('burst_rifle', 'epic');
  assert.equal(burst.fireMode, 'burst');
  assert.equal(burst.burstCount, 3);
  assert.equal(burst.burstIntervalSeconds, 0.075);
  assert.equal(calculateWeaponDamage(burst, false), 30);
  assert.equal(createWeaponStats('sniper', 'legendary').baseDamage, 113);
  assert.equal(
    calculateWeaponDamage(createWeaponStats('sniper', 'legendary'), true),
    226
  );
});

test('Upgrade 2.0 storm: slower schedule interpolates linearly to a final zone', async () => {
  const { storm } = await loadUpgradeModules();
  const state = storm.createInitialStormState();

  assert.equal(storm.STORM_TOTAL_SCHEDULE_SECONDS, 691);
  assert.deepEqual(
    storm.STORM_PHASES.map((phase) => [
      phase.waitSeconds,
      phase.shrinkSeconds,
      phase.targetRadius,
      phase.damagePerSecond,
    ]),
    [
      [90, 70, 150, 1],
      [70, 60, 105, 2],
      [55, 50, 72, 3],
      [45, 42, 48, 5],
      [35, 34, 30, 7],
      [28, 28, 18, 9],
      [22, 24, 10, 12],
      [18, 20, 4, 15],
    ]
  );
  assert.equal(state.phaseTimer, 90);
  assert.equal(state.currentRadius, 255);
  assert.equal(state.targetRadius, 150);
  assert.equal(state.damagePerSecond, 1);
  assert.equal(storm.getStormStatusLabel(state), 'SHRINKS IN');

  storm.advanceStormState(state, 90);
  assert.equal(state.isShrinking, true);
  assert.equal(state.phaseTimer, 70);
  assert.equal(state.currentRadius, 255);
  assert.equal(storm.getStormStatusLabel(state), 'SHRINKING');

  storm.advanceStormState(state, 35);
  assert.equal(state.phase, 1);
  assert.equal(state.currentRadius, 202.5);
  assert.equal(state.currentCenterX, 6);
  assert.equal(state.currentCenterZ, -5);
  assert.equal(state.phaseTimer, 35);

  storm.advanceStormState(state, 35);
  assert.equal(state.phase, 2);
  assert.equal(state.currentRadius, 150);
  assert.equal(state.targetRadius, 105);
  assert.equal(state.phaseTimer, 70);
  assert.equal(state.damagePerSecond, 2);
  const targetDistance = Math.hypot(
    state.targetCenterX - state.currentCenterX,
    state.targetCenterZ - state.currentCenterZ
  );
  assert.ok(targetDistance + state.targetRadius <= state.currentRadius + 1e-9);

  const adoptedSnapshot = {
    ...storm.createInitialStormState(),
    currentCenterX: 6,
    currentCenterZ: -5,
    currentRadius: 202.5,
    targetCenterX: 12,
    targetCenterZ: -10,
    targetRadius: 150,
    phaseTimer: 35,
    isShrinking: true,
    shrinkDuration: 0,
    shrinkElapsed: 0,
  };
  storm.advanceStormState(adoptedSnapshot, 17.5);
  assert.equal(adoptedSnapshot.currentRadius, 176.25);
  assert.equal(adoptedSnapshot.currentCenterX, 9);
  assert.equal(adoptedSnapshot.currentCenterZ, -7.5);

  let previousRadius = state.currentRadius;
  for (let elapsed = 0; elapsed < 531; elapsed += 10) {
    storm.advanceStormState(state, 10);
    assert.ok(state.currentRadius <= previousRadius + 1e-9);
    previousRadius = state.currentRadius;
  }
  storm.advanceStormState(state, 1);
  assert.equal(state.phase, 9);
  assert.equal(state.currentRadius, 4);
  assert.equal(state.phaseTimer, 0);
  assert.equal(state.damagePerSecond, 15);
  assert.equal(storm.getStormStatusLabel(state), 'FINAL ZONE');
});

test('Upgrade 2.0 synchronization: server mirrors weapons/storm and burst firing is wired', () => {
  const read = (relativePath) => fs.readFileSync(path.join(ROOT_DIR, relativePath), 'utf8');
  const server = read('server/multiplayerServer.mjs');

  for (const category of [
    'heavy_pistol',
    'burst_rifle',
    'dmr',
    'tactical_shotgun',
  ]) {
    assert.match(server, new RegExp(category));
  }
  assert.match(server, /SERVER_WEAPON_CATALOG/);
  assert.match(server, /getServerWeaponDamage\(weaponStats, isHeadshot\)/);
  assert.match(server, /consumeServerShot\(shooter, weaponStats\)/);
  assert.match(server, /consumeServerHitCredit\(attacker, weaponStats\)/);
  assert.match(server, /weaponStats\.range \+ rangeAllowance/);
  assert.match(server, /category === 'harvester' \? 1 : 12/);
  assert.doesNotMatch(server, /Math\.min\(240, Math\.round\(Number\(msg\.damage/);
  assert.doesNotMatch(server, /const isHeadshot = Boolean\(msg\.isHeadshot\)/);
  assert.match(server, /validatedHitPoint\.y - Number\(victim\.position\?\.y/);

  for (const row of [
    '{ phase: 1, waitSeconds: 90, shrinkSeconds: 70, targetRadius: 150, damagePerSecond: 1 }',
    '{ phase: 2, waitSeconds: 70, shrinkSeconds: 60, targetRadius: 105, damagePerSecond: 2 }',
    '{ phase: 3, waitSeconds: 55, shrinkSeconds: 50, targetRadius: 72, damagePerSecond: 3 }',
    '{ phase: 4, waitSeconds: 45, shrinkSeconds: 42, targetRadius: 48, damagePerSecond: 5 }',
    '{ phase: 5, waitSeconds: 35, shrinkSeconds: 34, targetRadius: 30, damagePerSecond: 7 }',
    '{ phase: 6, waitSeconds: 28, shrinkSeconds: 28, targetRadius: 18, damagePerSecond: 9 }',
    '{ phase: 7, waitSeconds: 22, shrinkSeconds: 24, targetRadius: 10, damagePerSecond: 12 }',
    '{ phase: 8, waitSeconds: 18, shrinkSeconds: 20, targetRadius: 4, damagePerSecond: 15 }',
  ]) {
    assert.ok(server.includes(row), `server storm row missing: ${row}`);
  }

  const playerController = read('src/entities/PlayerController.ts');
  assert.match(playerController, /burstQueues/);
  assert.match(playerController, /executeWeaponShot\(/);
  assert.match(playerController, /burstIntervalSeconds/);
  assert.match(playerController, /calculateWeaponDamage\(stats, isHead\)/);

  const loot = read('src/systems/LootSystem.ts');
  assert.match(loot, /FIREARM_CATEGORIES/);
  const network = read('src/network/NetworkManager.ts');
  assert.match(network, /weaponCategory/);
  assert.match(network, /weaponRarity/);
  assert.match(network, /createInitialStormState\(\)/);
});
