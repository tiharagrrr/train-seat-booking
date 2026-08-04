INSERT INTO routes(name) VALUES('Colombo Fort–Badulla');
INSERT INTO stations(code,name) VALUES ('FOT','Colombo Fort'),('GPH','Gampaha'),('RGM','Ragama'),('PLG','Polgahawela'),('KDT','Kandy'),('HTN','Hatton'),('NOG','Nanu Oya'),('ELL','Ella'),('BAD','Badulla');
INSERT INTO route_stations(route_id,station_id,position,distance_to_next_km)
SELECT r.id,s.id,x.position,x.km FROM routes r
JOIN (VALUES('FOT',0,27.0),('GPH',1,14.0),('RGM',2,47.0),('PLG',3,42.0),('KDT',4,78.0),('HTN',5,39.0),('NOG',6,77.0),('ELL',7,32.0),('BAD',8,0.0)) x(code,position,km) ON true
JOIN stations s ON s.code=x.code WHERE r.name='Colombo Fort–Badulla';
INSERT INTO train_templates(name) VALUES('Udarata Menike Standard Formation');
INSERT INTO coach_templates(train_template_id,coach_code,class_name,reserved,rate_per_km_lkr,display_order)
SELECT t.id,x.code,x.class_name,x.reserved,x.rate,x.ord FROM train_templates t CROSS JOIN
(VALUES('R1','First Class',true,14.00,1),('R2','Second Class',true,9.00,2),('R3','Second Class',true,9.00,3),
('U1','Third Class',false,4.00,4),('U2','Third Class',false,4.00,5),('U3','Third Class',false,4.00,6),('U4','Third Class',false,4.00,7),('U5','Third Class',false,4.00,8)) x(code,class_name,reserved,rate,ord);
INSERT INTO seat_templates(coach_template_id,seat_number,row_number,column_number)
SELECT c.id,lpad(n::text,2,'0'),((n-1)/4)+1,((n-1)%4)+1 FROM coach_templates c CROSS JOIN generate_series(1,24)n WHERE c.reserved;
INSERT INTO service_schedules(route_id,train_template_id,service_code,departure_time,active_from)
SELECT r.id,t.id,'1005','05:55',current_date FROM routes r CROSS JOIN train_templates t;
INSERT INTO service_runs(schedule_id,route_id,service_code,departure_at)
SELECT s.id,s.route_id,s.service_code,date_trunc('day',now())+interval '1 day 05:55' FROM service_schedules s;
INSERT INTO coaches(run_id,source_template_id,coach_code,class_name,reserved,rate_per_km_lkr,display_order)
SELECT sr.id,ct.id,ct.coach_code,ct.class_name,ct.reserved,ct.rate_per_km_lkr,ct.display_order
FROM service_runs sr JOIN service_schedules ss ON ss.id=sr.schedule_id JOIN coach_templates ct ON ct.train_template_id=ss.train_template_id;
INSERT INTO seats(coach_id,source_template_id,seat_number,row_number,column_number,accessible,active)
SELECT c.id,st.id,st.seat_number,st.row_number,st.column_number,st.accessible,st.active
FROM coaches c JOIN seat_templates st ON st.coach_template_id=c.source_template_id;
