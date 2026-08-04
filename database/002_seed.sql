INSERT INTO routes (name) VALUES ('Colombo Fort–Badulla');
INSERT INTO stations (code, name) VALUES
 ('FOT','Colombo Fort'), ('GPH','Gampaha'), ('RGM','Ragama'), ('PLG','Polgahawela'),
 ('KDT','Kandy'), ('HTN','Hatton'), ('NOG','Nanu Oya'), ('ELL','Ella'), ('BAD','Badulla');
INSERT INTO route_stations (route_id, station_id, position, distance_km)
SELECT r.id, s.id, x.position, x.distance_km FROM routes r
JOIN (VALUES ('FOT',0,27.0),('GPH',1,14.0),('RGM',2,47.0),('PLG',3,42.0),
 ('KDT',4,78.0),('HTN',5,39.0),('NOG',6,77.0),('ELL',7,32.0),('BAD',8,0.0))
 AS x(code,position,distance_km) ON true JOIN stations s ON s.code=x.code
WHERE r.name='Colombo Fort–Badulla';
INSERT INTO service_runs (route_id, service_code, departure_at)
SELECT id, '1005', date_trunc('day', now()) + interval '1 day 05:55' FROM routes;
INSERT INTO coaches (run_id, coach_code, class_name, reserved, rate_per_km_cents)
SELECT sr.id, x.code, x.class_name, true, x.rate FROM service_runs sr
CROSS JOIN (VALUES ('R1','First Class',1400),('R2','Second Class',900),('R3','Second Class',900)) x(code,class_name,rate);
INSERT INTO seats (coach_id, seat_number, row_number, column_number)
SELECT c.id, lpad(n::text,2,'0'), ((n-1)/4)+1, ((n-1)%4)+1
FROM coaches c CROSS JOIN generate_series(1,24) n;
