# Suggested X Filtered Stream Rules

החוקים להלן הם נקודת פתיחה. צריך להתאים למגבלות החשבון ולרמת הרעש.

```text
(Trump OR "Trump administration" OR "White House" OR "Truth Social") ("funding" OR "equity stake" OR grant OR tariff OR tariffs OR China OR Pentagon OR "Commerce Department" OR "national security") -is:retweet lang:en
```

```text
("drone companies" OR "US drones" OR "domestic drone" OR "counter-drone" OR "Pentagon funding") -is:retweet lang:en
```

```text
("quantum computing" OR "quantum companies" OR "quantum funding" OR "Commerce Department" OR NIST) ($IONQ OR $RGTI OR $QBTS OR $QUBT OR $ARQQ) -is:retweet lang:en
```

```text
("rare earths" OR "critical minerals" OR "China export controls" OR "strategic minerals") ($MP OR $UUUU OR $USAR OR $REMX) -is:retweet lang:en
```

```text
("tariff" OR "tariffs" OR "import duty" OR "section 301") ("Trump" OR "White House" OR "China") -is:retweet lang:en
```
