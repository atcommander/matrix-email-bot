#!/bin/bash

email_host=$1
rate_limit=$2
src=$3

burst=0
sent=0

for i in $( ls $src | grep .eml | shuf )
do

start=$(date)

swaks --to help@altispeed.com --server $email_host:25 --from $i+pdennert@altispeed.com --data $src/$i

echo "$i"

((burst++))
((sent++))

if [ $burst -eq $rate_limit ]
then

burst=0

echo ""
echo "Emails Sent: $sent"
echo ""

sleep 1m

fi

done

echo ""
read -p "Press Enter When Last Message is Received"
echo ""

finish=$(date)

echo ""
echo "Test Results"
echo "Start: $start"
echo "End: $finish"
echo "Emails Sent: $sent"
echo "Emails Source: $src"
echo "Rate Limit: $rate_limit"